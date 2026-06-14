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
from langchain_core.messages import SystemMessage
from utils.logger_handler import logger

# Thread-local context for report mode flag
# Set by fill_context_for_report tool, read by state_modifier
_report_context = threading.local()


def get_report_context() -> bool:
    """Check if we're in report-generation mode."""
    return getattr(_report_context, "report", False)


def set_report_context(value: bool):
    """Set the report-generation mode flag."""
    _report_context.report = value


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
    """

    def state_modifier(state):
        # Check if we're in report mode (set by fill_context_for_report)
        is_report = getattr(_report_context, "report", False)
        prompt = report_prompt if is_report else main_prompt

        if is_report:
            logger.info("[report_prompt_switch] 使用报告生成提示词")

        messages = state.get("messages", [])
        return [SystemMessage(content=prompt)] + list(messages)

    return state_modifier
