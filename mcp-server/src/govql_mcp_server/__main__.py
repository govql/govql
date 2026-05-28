"""Entry point: ``govql-mcp-server`` / ``python -m govql_mcp_server``.

Starts the FastMCP server over the default stdio transport so any MCP client
that spawns this command as a subprocess can talk to it.
"""

from .logger import logger
from .server import mcp


def main() -> None:
    logger.info("starting govql-mcp-server")
    mcp.run()


if __name__ == "__main__":
    main()
