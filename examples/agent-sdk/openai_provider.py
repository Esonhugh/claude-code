# Python version of openai-provider.mjs: OpenAI provider + Daybreak blue through the official Python SDK.
import asyncio
import json
import os

from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, SystemMessage, query


async def main():
    options = ClaudeAgentOptions(
        cli_path=os.environ["CLAUDE_FORK_BIN"],
        env={"CLAUDE_CODE_USE_OPENAI": "1"},
        settings=json.dumps({"daybreak": "blue"}),
    )
    async for message in query(prompt="Say hello.", options=options):
        if isinstance(message, SystemMessage) and message.subtype == "init":
            print("init model=" + message.data["model"])
        if isinstance(message, ResultMessage):
            print("result", message.subtype, message.result)


asyncio.run(main())
