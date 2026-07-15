"""Guardrail: nothing in the package may write to stdout.

stdout is reserved for the MCP transport. A stray ``print()`` would corrupt
the JSON-RPC framing and silently break every client. This test enforces the
rule mechanically.
"""

from __future__ import annotations

import importlib
import sys

from tests.conftest import graphql_response, tool_payload

_PACKAGE_MODULES = [
    "govql_mcp_server",
    "govql_mcp_server.__main__",
    "govql_mcp_server.logger",
    "govql_mcp_server.graphql_client",
    "govql_mcp_server.server",
    "govql_mcp_server.tools",
    "govql_mcp_server.tools.passthrough",
    "govql_mcp_server.tools._discovery_shared",
    "govql_mcp_server.tools.list_types",
    "govql_mcp_server.tools.describe_type",
]


def test_no_module_writes_to_stdout_on_import(capsys):
    """Importing any module in the package must not produce stdout output."""
    for name in _PACKAGE_MODULES:
        if name in sys.modules:
            del sys.modules[name]
    for name in _PACKAGE_MODULES:
        importlib.import_module(name)
    captured = capsys.readouterr()
    assert captured.out == "", (
        f"Module import wrote to stdout — would corrupt the MCP transport. "
        f"Output: {captured.out!r}"
    )


async def test_no_tool_invocation_writes_to_stdout(
    capsys, client, mock_graphql, govql_endpoint
):
    """Invoking any tool must not produce stdout output."""
    mock_graphql.post(govql_endpoint).mock(
        return_value=graphql_response(data={"ok": True})
    )
    capsys.readouterr()  # drop any prior output

    result = await client.call_tool("execute_graphql", {"query": "{ ok }"})
    assert tool_payload(result)["data"] == {"ok": True}

    captured = capsys.readouterr()
    assert captured.out == "", (
        f"Tool invocation wrote to stdout. Output: {captured.out!r}"
    )
