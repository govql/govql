"""FastMCP server instance and tool registration.

Tool modules use ``from .server import mcp`` and then decorate handlers with
``@mcp.tool``. Those decorators run at import time, so importing the tool
modules at the bottom of this file is what registers them with the server.
"""

from fastmcp import FastMCP

from . import __version__

mcp = FastMCP("govql", version=__version__)

# Importing the tool modules runs their @mcp.tool decorators, registering them.
# Imports are at the bottom to break the circular import between this module
# and the tool modules (which import `mcp` from here).
from .tools import introspection, passthrough  # noqa: E402, F401
