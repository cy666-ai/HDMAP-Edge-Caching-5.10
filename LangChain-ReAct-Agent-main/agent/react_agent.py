"""
HLR-Cache ReAct Agent — core class wrapping langgraph.prebuilt.create_react_agent.

Provides an execute_stream() method that yields text chunks as the agent
reasons and calls tools. Compatible with the newer langgraph API.
"""

import asyncio
from concurrent.futures import ThreadPoolExecutor

from langgraph.prebuilt import create_react_agent
from langchain_core.messages import AIMessageChunk, HumanMessage, ToolMessage, SystemMessage

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

    def execute_stream(self, query: str):
        """
        Execute the agent and yield text chunks streamingly.

        Uses stream_mode="messages" for token-level streaming from the LLM.
        Each chunk is a small piece of text (often single tokens) that the
        frontend can display character-by-character for a typewriter effect.

        Tool results and other non-LLM messages are yielded as complete chunks.
        """
        # Reset report context for each query
        set_report_context(False)

        input_dict = {
            "messages": [
                {"role": "user", "content": query},
            ]
        }

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

                # LLM token chunks (AIMessageChunk) — may contain text content
                # or be a tool-call request with no text
                if isinstance(message_chunk, AIMessageChunk):
                    content = message_chunk.content
                    if content:
                        # content can be str (text token) or list (multi-modal)
                        if isinstance(content, str):
                            yield content
                        elif isinstance(content, list):
                            for item in content:
                                if isinstance(item, dict) and item.get("type") == "text":
                                    yield item["text"]
                    # else: tool-call chunk with no text — nothing to yield
                    continue

                # Any other message type with content
                if hasattr(message_chunk, "content") and message_chunk.content:
                    content = message_chunk.content
                    if isinstance(content, str):
                        yield content
        except Exception as e:
            logger.error(f"[ReactAgent] Stream error: {e}")
            yield f"\n[Agent Error] {str(e)}\n"

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
