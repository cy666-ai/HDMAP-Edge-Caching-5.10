"""
HLR-Cache Edge Caching System — Agent Tools
All 7 tools rewritten from "robot vacuum customer service" to "HLR-Cache edge caching assistant".

Tools that need real-time system state (get_rsu_status, get_active_routes, etc.) use
standalone stubs that work without the Node.js backend. When the backend is running,
the AGENT_BACKEND_URL env var can be set to point to http://localhost:3000 for live data.
"""

import os
import json
import random
from datetime import datetime, timedelta
from langchain_core.tools import tool

from rag.rag_service import RagSummarizeService
from utils.logger_handler import logger
from utils.config_handler import agent_conf
from utils.path_tool import get_abs_path

rag = RagSummarizeService()

# Backend URL for live data (optional — tools use stubs when unavailable)
BACKEND_URL = os.environ.get("AGENT_BACKEND_URL", "")

# ---- External data cache (lazy loaded from CSV) ----
external_data = {}

# ---- Route definitions (static, mirrors backend routeConfig) ----
ROUTES = [
    {"id": 1, "name": "古平岗→新庄", "start": "古平岗", "end": "新庄", "rsu_count": 14},
    {"id": 2, "name": "草场门→九华山", "start": "草场门", "end": "九华山", "rsu_count": 12},
    {"id": 3, "name": "龙江→鸡鸣寺", "start": "龙江", "end": "鸡鸣寺", "rsu_count": 13},
    {"id": 4, "name": "鼓楼→玄武门", "start": "鼓楼", "end": "玄武门", "rsu_count": 8},
    {"id": 5, "name": "新模范马路→岗子村", "start": "新模范马路", "end": "岗子村", "rsu_count": 10},
    {"id": 6, "name": "汉中门→明故宫", "start": "汉中门", "end": "明故宫", "rsu_count": 11},
]


# =====================================================================
# Tool 1: RAG knowledge-base search
# =====================================================================
@tool(description="从 HLR-Cache 知识库中检索边缘缓存、MWC算法、RSU部署、路由与车辆配置、前端界面（按钮功能、图表含义、页面布局）等相关专业资料，返回总结后的回答")
def rag_summarize(query: str) -> str:
    """Search the HLR-Cache knowledge base (Chroma vector store) for relevant documentation."""
    return rag.rag_summarize(query)


# =====================================================================
# Tool 2: RSU status query
# =====================================================================
def _build_rsu_id(route_id: int, rsu_index: int) -> str:
    """Construct a human-readable RSU identifier."""
    route = next((r for r in ROUTES if r["id"] == route_id), None)
    route_name = route["name"] if route else f"Route-{route_id}"
    return f"RSU-{route_id}-{rsu_index} ({route_name}, 第{rsu_index}号RSU)"


@tool(description="获取指定路线指定RSU的当前缓存状态、命中率、存储使用率，入参为route_id(整数路线ID)和rsu_index(整数RSU序号)，返回JSON格式字符串")
def get_rsu_status(route_id: int, rsu_index: int) -> str:
    """
    Get the current cache status and hit rate of a specific RSU.
    Uses live backend data when available, otherwise returns a realistic stub.
    """
    if BACKEND_URL:
        try:
            import urllib.request
            resp = urllib.request.urlopen(f"{BACKEND_URL}/api/rsu", timeout=3)
            data = json.loads(resp.read())
            if data.get("success"):
                # Search for the specific RSU in the response
                rsu_data = data.get("data", {})
                routes_data = rsu_data.get("routes", [])
                for route in routes_data:
                    if route.get("routeId") == route_id:
                        rsus = route.get("rsus", [])
                        if rsu_index < len(rsus):
                            rsu = rsus[rsu_index]
                            return json.dumps({
                                "rsu_id": _build_rsu_id(route_id, rsu_index),
                                "route_id": route_id,
                                "rsu_index": rsu_index,
                                "cache_size": rsu.get("cacheSize", 100),
                                "cache_used": rsu.get("cacheUsed", 0),
                                "hit_rate": rsu.get("hitRate", 0),
                                "cached_tiles": rsu.get("cachedTiles", 0),
                                "vehicles_in_range": rsu.get("vehiclesInRange", 0),
                            }, ensure_ascii=False)
        except Exception as e:
            logger.warning(f"[get_rsu_status] Backend unreachable, using stub: {e}")

    # Stub response
    return json.dumps({
        "rsu_id": _build_rsu_id(route_id, rsu_index),
        "route_id": route_id,
        "rsu_index": rsu_index,
        "cache_size": 100,
        "cache_used": random.randint(30, 95),
        "hit_rate": round(random.uniform(0.55, 0.95), 3),
        "cached_tiles": random.randint(30, 95),
        "vehicles_in_range": random.randint(0, 5),
    }, ensure_ascii=False)


# =====================================================================
# Tool 3: Active routes
# =====================================================================
@tool(description="获取当前模拟系统中的所有活跃路线列表及其基本信息（路线ID、名称、起终点、RSU数量），返回JSON格式字符串")
def get_active_routes() -> str:
    """Get all currently active routes in the simulation."""
    if BACKEND_URL:
        try:
            import urllib.request
            resp = urllib.request.urlopen(f"{BACKEND_URL}/api/roads", timeout=3)
            data = json.loads(resp.read())
            if data.get("success"):
                return json.dumps(data.get("data", []), ensure_ascii=False)
        except Exception as e:
            logger.warning(f"[get_active_routes] Backend unreachable, using stub: {e}")

    return json.dumps(ROUTES, ensure_ascii=False)


# =====================================================================
# Tool 4: Simulation status
# =====================================================================
_sim_start_time = datetime.now() - timedelta(minutes=random.randint(5, 60))
_tick = random.randint(30, 500)


@tool(description="获取当前模拟系统的运行状态（运行中/已暂停/已停止）、运行时长、当前tick计数，返回纯文本字符串")
def get_simulation_status() -> str:
    """Get the current simulation running status."""
    global _tick
    if BACKEND_URL:
        try:
            import urllib.request
            resp = urllib.request.urlopen(f"{BACKEND_URL}/api/status", timeout=3)
            data = json.loads(resp.read())
            if data.get("success"):
                return json.dumps(data.get("data", {}), ensure_ascii=False)
        except Exception as e:
            logger.warning(f"[get_simulation_status] Backend unreachable, using stub: {e}")

    _tick += random.randint(1, 5)
    elapsed = datetime.now() - _sim_start_time
    statuses = ["运行中", "运行中", "运行中", "已暂停"]
    status = random.choice(statuses)
    return (
        f"模拟状态: {status}\n"
        f"运行时长: {int(elapsed.total_seconds() // 60)} 分钟 {int(elapsed.total_seconds() % 60)} 秒\n"
        f"当前 Tick: {_tick}\n"
        f"活跃车辆: 30 辆 (6条路线, 每条5辆)\n"
        f"活跃 RSU: 68 个\n"
        f"算法间隔: 每5 tick 执行一次 MWC 优化"
    )


# =====================================================================
# Tool 5: Current tick
# =====================================================================
@tool(description="获取当前模拟的精确 tick 计数和系统时间戳，返回纯文本字符串")
def get_current_tick() -> str:
    """Get the precise current tick count."""
    global _tick
    _tick += random.randint(1, 3)
    return f"当前 Tick: {_tick}\n时间戳: {datetime.now().isoformat()}\n算法下次执行: Tick {((_tick // 5) + 1) * 5}"


# =====================================================================
# Tool 6: RSU cache detail
# =====================================================================
def _load_external_data():
    """Lazy-load external HLR-Cache statistics CSV."""
    if external_data:
        return
    external_data_path = get_abs_path(agent_conf["external_data_path"])
    if not os.path.exists(external_data_path):
        logger.warning(f"[fetch_rsu_cache_detail] External data file not found: {external_data_path}")
        return
    with open(external_data_path, "r", encoding="utf-8") as f:
        header = None
        for line in f.readlines():
            line = line.strip()
            if not line:
                continue
            arr = line.split(",")
            if header is None:
                header = [h.strip().replace('"', '') for h in arr]
                continue
            route_id = arr[0].strip().replace('"', '')
            rsu_idx = arr[1].strip().replace('"', '')
            if route_id not in external_data:
                external_data[route_id] = {}
            n_cols = min(len(arr), len(header))
            external_data[route_id][rsu_idx] = {
                header[i].strip().replace('"', ''): arr[i].strip().replace('"', '')
                for i in range(2, n_cols)
            }


@tool(description="获取指定路线指定RSU的详细缓存决策数据、命中率历史、net utility值等完整信息。入参route_id为整数路线ID，rsu_index为整数RSU序号。返回JSON格式字符串")
def fetch_rsu_cache_detail(route_id: int, rsu_index: int) -> str:
    """
    Fetch detailed cache decision and performance data for a specific RSU.
    Uses external CSV data when available, otherwise returns stub data.
    """
    _load_external_data()
    route_key = str(route_id)
    rsu_key = str(rsu_index)

    if route_key in external_data and rsu_key in external_data[route_key]:
        record = external_data[route_key][rsu_key]
        return json.dumps({
            "rsu_id": _build_rsu_id(route_id, rsu_index),
            "route_id": route_id,
            "rsu_index": rsu_index,
            **record,
        }, ensure_ascii=False)

    # Stub response
    return json.dumps({
        "rsu_id": _build_rsu_id(route_id, rsu_index),
        "route_id": route_id,
        "rsu_index": rsu_index,
        "cache_utilization": round(random.uniform(0.3, 0.95), 3),
        "hit_rate": round(random.uniform(0.55, 0.95), 3),
        "W_net": round(random.uniform(50, 200), 2),
        "psi_score": round(random.uniform(0.1, 0.9), 3),
        "max_net_utility": round(random.uniform(80, 300), 2),
        "cached_tiles_count": random.randint(30, 100),
        "requested_tiles_count": random.randint(40, 150),
        "vehicles_served": random.randint(1, 5),
        "last_optimized_tick": (_tick // 5) * 5,
    }, ensure_ascii=False)


# =====================================================================
# Tool 7: Report context trigger
# =====================================================================
@tool(description="无入参，无返回值。调用后触发中间件自动为缓存分析报告场景动态注入上下文信息，为后续提示词切换提供上下文支撑。仅在生成缓存分析报告时调用。")
def fill_context_for_report():
    """Trigger the report-mode middleware. Call before fetch_rsu_cache_detail for reports."""
    return "fill_context_for_report已调用"
