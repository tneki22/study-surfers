import asyncio
import sys

import pytest
from uvicorn import Config


@pytest.mark.parametrize("reload", [False, True])
def test_uvicorn_loop_can_run_subscription_processes_with_and_without_reload(reload):
    factory = Config(
        "app.main:app", reload=reload, loop="app.event_loop:loop_factory"
    ).get_loop_factory()

    async def run_process():
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", "print('ready')", stdout=asyncio.subprocess.PIPE
        )
        output, _ = await process.communicate()
        assert process.returncode == 0
        assert output.strip() == b"ready"

    with asyncio.Runner(loop_factory=factory) as runner:
        runner.run(run_process())
