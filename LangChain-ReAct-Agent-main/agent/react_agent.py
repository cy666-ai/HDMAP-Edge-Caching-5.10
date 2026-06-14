"""
HLR-Cache ReAct Agent — core class wrapping langgraph.prebuilt.create_react_agent.

Provides an execute_stream() method that yields text chunks as the agent
reasons and calls tools. Compatible with the newer langgraph API.
"""

import asyncio
import traceback
from concurrent.futures import ThreadPoolExecutor

from langgraph.prebuilt import create_react_agent
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage, SystemMessage

from model.factory import chat_model
from utils.prompt_loader import load_system_prompts, load_report_prompts
from utils.logger_handler import logger

from agent.tools.agent_tools import (
    rag_summarize, get_rsu_status, get_active_routes,
    get_simulation_status, get_current_tick, fetch_rsu_cache_detail,
    fill_context_for_report,
)
from agent.tools.middleware import (
    wrap_tool_logging, make_state_modifier, get_report_context, set_report_context,
    get_rag_called, set_rag_called,
)


class ReactAgent:
    """
    ReAct-pattern agent for the HLR-Cache edge-caching system.

    Wraps langgraph's create_react_agent with 7 HLR-Cache domain tools,
    tool-call logging middleware, and dynamic prompt switching for
    report-generation mode.
    """

    def __init__(self, system_prompt: str = None):
        self.main_prompt = system_prompt or load_system_prompts()
        self.report_prompt = load_report_prompts()

        # Raw tools
        raw_tools = [
            rag_summarize, get_rsu_status, get_active_routes,
            get_simulation_status, get_current_tick, fetch_rsu_cache_detail,
            fill_context_for_report,
        ]

        # Wrap each tool with call logging
        self.tools = [wrap_tool_logging(t) for t in raw_tools]

        # State modifier that dynamically switches prompts
        state_modifier = make_state_modifier(self.main_prompt, self.report_prompt)

        # Build the agent graph
        self.agent = create_react_agent(
            model=chat_model,
            tools=self.tools,
            state_modifier=state_modifier,
        )
        # Limit total ReAct iterations: tool_recur + text_gen + report proc ≈ up to 25
        self.recursion_limit = 10
        logger.info(f"[ReactAgent] Agent initialized with 7 HLR-Cache tools (recursion_limit={self.recursion_limit})")

    @staticmethod
    def _deduplicate(text: str) -> str:
        """
        Detect and remove semantic duplicates from the model output.

        qwen-plus has a tendency to give an answer and then rephrase it in different
        words within the same generation. This function detects when the second half
        of the text is too similar to the first half (by character-bigram Jaccard)
        and truncates at the nearest sentence boundary before the midpoint.
        """
        if len(text) < 80:
            return text  # Too short to contain a duplicate

        mid = len(text) // 2
        first_half = text[:mid]
        second_half = text[mid:]

        def char_bigrams(s: str):
            return {s[i : i + 2] for i in range(len(s) - 1)}

        b1 = char_bigrams(first_half)
        b2 = char_bigrams(second_half)

        if not b1 or not b2:
            return text

        jaccard = len(b1 & b2) / len(b1 | b2)

        # Empirical threshold: >0.25 bigram overlap between halves means
        # the model is saying the same thing twice with different words.
        if jaccard > 0.25:
            # Find the rightmost sentence boundary at or before the midpoint
            # so we don't cut in the middle of a word
            truncate_at = 0
            for sep in ("。", "！", "？", "\n", "；"):
                pos = text.rfind(sep, 0, mid)
                if pos > truncate_at:
                    truncate_at = pos + 1  # +1 to include the separator

            if truncate_at == 0:
                truncate_at = mid  # Fallback: no sentence boundary found

            trimmed = text[:truncate_at].strip()
            logger.info(
                f"[ReactAgent] Semantic duplicate detected (Jaccard={jaccard:.3f}), "
                f"trimming from {len(text)} to {len(trimmed)} chars"
            )
            return trimmed

        return text

    def execute_stream(self, query: str):
        """
        Execute the agent and yield text chunks streamingly.

        Uses stream_mode="messages" for token-level streaming from the LLM.
        Each chunk is a small piece of text (often single tokens) that the
        frontend can display character-by-character for a typewriter effect.

        Tool results and other non-LLM messages are yielded as complete chunks.

        To combat qwen-plus's tendency to rephrase its own answer, all chunks
        are buffered first, then deduplicated before yielding.
        """
        # Reset context flags for each query
        set_report_context(False)
        set_rag_called(False)

        input_dict = {
            "messages": [
                {"role": "user", "content": query},
            ]
        }

        # Buffer all chunks to enable post-generation deduplication
        chunks = []

        try:
            for message_chunk, metadata in self.agent.stream(
                input_dict,
                stream_mode="messages",
                config={"recursion_limit": self.recursion_limit},
            ):
                # Skip user messages echoed back from state
                if isinstance(message_chunk, HumanMessage):
                    continue

                # Tool results — skip silently. The agent uses them internally
                # for reasoning, but users only see the final natural-language reply.
                if isinstance(message_chunk, ToolMessage):
                    continue

                # Skip the final assembled AIMessage (but NOT AIMessageChunk, which is
                # a subclass) — its content has already been streamed token-by-token
                # via AIMessageChunk above. Yielding it again would cause the entire
                # response to appear twice (duplicate answer).
                if isinstance(message_chunk, AIMessage) and not isinstance(message_chunk, AIMessageChunk):
                    continue

                # LLM token chunks (AIMessageChunk) — may contain text content
                # or be a tool-call request with no text
                if isinstance(message_chunk, AIMessageChunk):
                    content = message_chunk.content
                    if content:
                        # content can be str (text token) or list (multi-modal)
                        if isinstance(content, str):
                            chunks.append(content)
                        elif isinstance(content, list):
                            for item in content:
                                if isinstance(item, dict) and item.get("type") == "text":
                                    chunks.append(item["text"])
                    # else: tool-call chunk with no text — nothing to yield
                    continue

                # Any other unexpected message type with content — log and skip
                # to avoid accidentally yielding duplicate or internal content
                if hasattr(message_chunk, "content") and message_chunk.content:
                    logger.debug(
                        f"[ReactAgent] Skipping unexpected message type "
                        f"{type(message_chunk).__name__}: {str(message_chunk.content)[:100]}"
                    )
        except Exception as e:
            logger.error(f"[ReactAgent] Stream error: {e}")
            traceback.print_exc()
            yield f"\n[Agent Error] {str(e)}\n"
            return

        # Post-process: deduplicate then yield
        full_text = "".join(chunks)
        deduped = self._deduplicate(full_text)
        if deduped:
            yield deduped

    async def execute_stream_async(self, query: str):
        """
        Async version of execute_stream — bridges sync LLM calls to async via
        a thread pool so that blocking DashScope HTTP requests don't starve the
        asyncio event loop (which would break /health checks and other endpoints).

        Uses run_in_executor to run the sync generator in a background thread,
        pumping chunks through an asyncio.Queue so the FastAPI SSE endpoint
        can async-iterate without blocking.
        """
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        def _sync_stream():
            """Run the blocking execute_stream() in a worker thread."""
            try:
                for chunk in self.execute_stream(query):
                    loop.call_soon_threadsafe(queue.put_nowait, (chunk, None))
            except Exception as exc:
                loop.call_soon_threadsafe(queue.put_nowait, (None, exc))
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, (None, None))  # sentinel

        with ThreadPoolExecutor(max_workers=1) as pool:
            loop.run_in_executor(pool, _sync_stream)

            while True:
                chunk, error = await queue.get()
                if chunk is None and error is None:
                    break  # sentinel — stream finished
                if error is not None:
                    raise error
                yield chunk


if __name__ == '__main__':
    # Quick smoke test (requires DASHSCOPE_API_KEY env var)
    agent = ReactAgent()

    print("=== HLR-Cache ReAct Agent — Smoke Test ===")
    query = "介绍一下 HLR-Cache 系统的 MWC 算法"
    print(f"Query: {query}")
    print("---")

    for chunk in agent.execute_stream(query):
        print(chunk, end="", flush=True)
    print("\n=== Done ===")
