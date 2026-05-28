import logging
import os
import sys

logger = logging.getLogger("govql_mcp_server")
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())

# stderr only — stdout is reserved for the MCP transport.
_handler = logging.StreamHandler(sys.stderr)
_handler.setFormatter(
    logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
)
logger.addHandler(_handler)
logger.propagate = False
