from abc import ABC, abstractmethod
from typing import Optional, Union
from langchain_core.embeddings import Embeddings
from langchain_community.chat_models.tongyi import BaseChatModel
from langchain_community.embeddings import DashScopeEmbeddings
from langchain_community.chat_models.tongyi import ChatTongyi
from utils.config_handler import rag_conf

# DashScope API Key (hardcoded)
DASHSCOPE_API_KEY = "sk-1b5e914149c9419cb91caa7fba15b52b"


def _patch_subtract_client_response():
    """
    Fix a langchain_community bug in ChatTongyi.subtract_client_response.

    When the DashScope API streams tool_calls incrementally, the current
    accumulated response may have more tool_calls entries than the previous
    response. The original code loops over `message["tool_calls"]` and blindly
    indexes into `prev_message["tool_calls"]` with the same index, causing
    `IndexError: list index out of range`.

    This monkey-patch limits the iteration to the number of tool_calls that
    existed in the *previous* message, which is the correct delta to compute.
    """
    import json

    original = ChatTongyi.subtract_client_response

    def patched(self, resp, prev_resp):
        resp_copy = json.loads(json.dumps(resp))
        choice = resp_copy["output"]["choices"][0]
        message = choice["message"]

        prev_resp_copy = json.loads(json.dumps(prev_resp))
        prev_choice = prev_resp_copy["output"]["choices"][0]
        prev_message = prev_choice["message"]

        message["content"] = message["content"].replace(prev_message["content"], "")

        if message.get("tool_calls") and prev_message.get("tool_calls"):
            prev_tool_calls_count = len(prev_message["tool_calls"])
            for index, tool_call in enumerate(message["tool_calls"]):
                # Only subtract up to the count that existed in the previous response
                if index >= prev_tool_calls_count:
                    break
                function = tool_call["function"]
                prev_function = prev_message["tool_calls"][index]["function"]
                if "name" in function:
                    function["name"] = function["name"].replace(
                        prev_function["name"], ""
                    )
                if "arguments" in function:
                    function["arguments"] = function["arguments"].replace(
                        prev_function["arguments"], ""
                    )

        return resp_copy

    ChatTongyi.subtract_client_response = patched


# Apply the bugfix before any ChatTongyi instances are created
_patch_subtract_client_response()


class BaseModelFactory(ABC):
    @abstractmethod
    def generator(self) -> Optional[Union[Embeddings, BaseChatModel]]:
        pass


class ChatModelFactory(BaseModelFactory):
    def generator(self) -> Optional[Union[Embeddings, BaseChatModel]]:
        return ChatTongyi(
            model=rag_conf["chat_model_name"],
            dashscope_api_key=DASHSCOPE_API_KEY,
            model_kwargs={
                "repetition_penalty": 1.15,  # 适度惩罚重复token
                "temperature": 0.5,           # 适中温度，避免低温度导致循环
            },
            top_p=0.85,              # nucleus sampling
        )


class EmbeddingsFactory(BaseModelFactory):
    def generator(self) -> Optional[Union[Embeddings, BaseChatModel]]:
        return DashScopeEmbeddings(
            model=rag_conf["embedding_model_name"],
            dashscope_api_key=DASHSCOPE_API_KEY,
        )


chat_model = ChatModelFactory().generator()

embed_model = EmbeddingsFactory().generator()
