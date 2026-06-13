from abc import ABC, abstractmethod
from typing import Optional, Union
from langchain_core.embeddings import Embeddings
from langchain_community.chat_models.tongyi import BaseChatModel
from langchain_community.embeddings import DashScopeEmbeddings
from langchain_community.chat_models.tongyi import ChatTongyi
from utils.config_handler import rag_conf

# DashScope API Key (hardcoded)
DASHSCOPE_API_KEY = "sk-1b5e914149c9419cb91caa7fba15b52b"


class BaseModelFactory(ABC):
    @abstractmethod
    def generator(self) -> Optional[Union[Embeddings, BaseChatModel]]:
        pass


class ChatModelFactory(BaseModelFactory):
    def generator(self) -> Optional[Union[Embeddings, BaseChatModel]]:
        return ChatTongyi(
            model=rag_conf["chat_model_name"],
            dashscope_api_key=DASHSCOPE_API_KEY,
        )


class EmbeddingsFactory(BaseModelFactory):
    def generator(self) -> Optional[Union[Embeddings, BaseChatModel]]:
        return DashScopeEmbeddings(
            model=rag_conf["embedding_model_name"],
            dashscope_api_key=DASHSCOPE_API_KEY,
        )


chat_model = ChatModelFactory().generator()

embed_model = EmbeddingsFactory().generator()
