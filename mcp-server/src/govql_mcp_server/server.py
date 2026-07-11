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
from .tools import (  # noqa: E402, F401
    compare_voters,
    describe_type,
    find_legislator,
    find_vote,
    get_legislator,
    get_vote_with_positions,
    get_voting_record,
    list_types,
    passthrough,
)
