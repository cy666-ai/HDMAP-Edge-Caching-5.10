"""
Middleware hooks for the HLR-Cache ReAct Agent.
Adapted from the old langchain.agents middleware API to work with langgraph.prebuilt.create_react_agent.

Functions:
  - wrap_tool_logging(tool): wraps a tool with call logging (preserves schema)
  - make_state_modifier(main_prompt, report_prompt): returns a state_modifier callable
    that dynamically switches between main and report prompts based on a thread-local context flag.
"""

import threading
import copy
from typing import Callable
from langchain_core.messages import SystemMessage, ToolMessage
from utils.logger_handler import logger

# Thread-local context for report mode flag
# Set by fill_context_for_report tool, read by state_modifier
_report_context = threading.local()

# Track if rag_summarize has already been called for the current query
_rag_called = threading.local()


def get_report_context() -> bool:
    """Check if we're in report-generation mode."""
    return getattr(_report_context, "report", False)


def set_report_context(value: bool):
    """Set the report-generation mode flag."""
    _report_context.report = value


def get_rag_called() -> bool:
    """Check if rag_summarize has been called in the current query."""
    return getattr(_rag_called, "called", False)


def set_rag_called(value: bool):
    """Set the rag_summarize called flag."""
    _rag_called.called = value


def wrap_tool_logging(tool):
    """
    Wrap a tool so that every invocation logs the tool name and arguments.
    Preserves all original tool metadata (name, description, args_schema).
    If the tool is fill_context_for_report, also sets the report context flag.
    """
    original_func = tool.func
    tool_name = tool.name

    def logged_func(*args, **kwargs):
        logger.info(f"[tool monitor] 执行工具：{tool_name}")
        # Log args/kwargs (truncated)
        arg_str = ", ".join(
            [str(a)[:80] for a in args] +
            [f"{k}={str(v)[:80]}" for k, v in kwargs.items()]
        )
        logger.info(f"[tool monitor] 传入参数：{arg_str or '(none)'}")

        try:
            result = original_func(*args, **kwargs)
            logger.info(f"[tool monitor] 工具{tool_name}调用成功")

            # If fill_context_for_report was called, enable report mode
            if tool_name == "fill_context_for_report":
                set_report_context(True)
                logger.info(f"[tool monitor] 报告模式已启用")

            # If rag_summarize was called, set the flag to block redundant tools
            if tool_name == "rag_summarize":
                set_rag_called(True)
                logger.info(f"[tool monitor] RAG已调用，标记节流模式")

            return result
        except Exception as e:
            logger.error(f"工具{tool_name}调用失败，原因：{str(e)}")
            raise

    # Shallow copy the tool, replacing only the func — keeping args_schema intact
    wrapped = copy.copy(tool)
    wrapped.func = logged_func
    return wrapped


def make_state_modifier(main_prompt: str, report_prompt: str) -> Callable:
    """
    Create a state_modifier function for create_react_agent.
    Dynamically switches the system prompt based on the report context flag.
    When rag_summarize has been called (and the question is not a report request),
    injects a forceful instruction to stop calling tools and answer immediately.
    """

    # Anti-redundancy suffix injected after rag_summarize to prevent
    # the agent from calling unnecessary data tools (get_active_routes, etc.)
    RAG_THROTTLE_SUFFIX = (
        "\n\n【系统指令 - 工具节流】rag_summarize 已返回知识库信息。"
        "你现在必须直接生成最终回答，严禁再调用 get_active_routes、get_rsu_status、"
        "get_simulation_status、get_current_tick 等数据工具。"
        "只输出一次回答，不追加、不复述、不总结。立即停止。"
    )

    def state_modifier(state):
        # Check if we're in report mode (set by fill_context_for_report)
        is_report = getattr(_report_context, "report", False)
        rag_called = getattr(_rag_called, "called", False)

        prompt = report_prompt if is_report else main_prompt

        if is_report:
            logger.info("[report_prompt_switch] 使用报告生成提示词")

        # If rag_summarize has been called and we're not in report mode,
        # inject throttle instruction to prevent redundant tool calls
        if rag_called and not is_report:
            prompt = prompt + RAG_THROTTLE_SUFFIX
            logger.info("[rag_throttle] RAG节流指令已注入系统提示词")

        messages = state.get("messages", [])
        return [SystemMessage(content=prompt)] + list(messages)

    return state_modifier
