"""The Harbor agent behind `npm run bench`: one benchmark subject per run.

    harbor run -p <task> -a tools.harbor.dsh_agent:DshAgent \
      -m deepseek-official/deepseek-v4-flash --ak subject=pipeline --ak bot_tarball=<path>

with `PYTHONPATH` at this repository. `scripts/bench.ts` builds the command;
docs/design/evaluation.md defines the subjects.

* `session` and `session+skills` run one agent session with the task statement
  as its task, in `/app`.
* `pipeline` and `pipeline+skills` run `dsh-migrate run` on a copy of the
  fixture, as a consumer repository with publishing off, and apply the tree it
  would propose to `/app/fixture`. The task statement is not read: the pipeline
  takes its target from the dsh release installed in the task container.

Every subject runs in the pinned agent runtime of `container/agent-runtime`,
installed apart from the task's own dsh, with the migrate profile in
`/root/.dsh`, the home the task's dsh and its verifier use, and the setup ends
with `dsh-migrate self-test`. With `+skills`, the `plugin-upgrade` skill of the
vendored upgrade-skill commit is loaded.

The agent leaves in its log directory: `proposed.diff` (the fixture against
its baseline commit), `agent.log`, and for a pipeline `events.jsonl` and
`status.json`.
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import override

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

REPO = Path(__file__).resolve().parents[2]
SUBJECTS = ("pipeline", "pipeline+skills", "session", "session+skills")
RUNTIME_DIR = "/opt/dsh-agent-runtime"
DSH = f"{RUNTIME_DIR}/node_modules/.bin/dsh"
DSH_HOME = "/root/.dsh"
SKILLS_DIR = "/opt/dsh-migrate-skills"
SKILL = "plugin-upgrade"
WORK = "/tmp/dsh-migrate-bench"
STATUS_PREFIX = "dsh-migrate-status:"


class DshAgent(BaseAgent):
    SUPPORTS_WINDOWS = False

    def __init__(self, *args, subject: str = "session", bot_tarball: str | None = None, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        if subject not in SUBJECTS:
            raise ValueError(f"subject must be one of {', '.join(SUBJECTS)}, got {subject!r}")
        if not bot_tarball:
            raise ValueError("bot_tarball, the `npm pack` of this repository, is required")
        self._subject = subject
        self._tarball = Path(bot_tarball)
        self._skills = subject.endswith("+skills")
        provider, _, model = (self.model_name or "deepseek-official/deepseek-v4-flash").partition("/")
        self._provider = provider
        self._model = model or provider

    @staticmethod
    @override
    def name() -> str:
        return "dsh-migrate-bench"

    @override
    def version(self) -> str | None:
        manifest = json.loads((REPO / "container" / "agent-runtime" / "package.json").read_text())
        return manifest["dependencies"]["@deepseek-ai/dsh"]

    async def _exec(self, environment: BaseEnvironment, command: str, **kwargs) -> str:
        result = await environment.exec(command=command, **kwargs)
        if result.return_code != 0:
            raise RuntimeError(f"`{command[:120]}` exited {result.return_code}: {(result.stderr or result.stdout or '').strip()[-800:]}")
        return result.stdout or ""

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        await self._exec(environment, f"mkdir -p {RUNTIME_DIR} {DSH_HOME}/profiles/migrate {SKILLS_DIR} {WORK}")
        for name in ("package.json", "package-lock.json"):
            await environment.upload_file(REPO / "container" / "agent-runtime" / name, f"{RUNTIME_DIR}/{name}")
        await self._exec(environment, f"cd {RUNTIME_DIR} && npm ci --omit=dev --no-audit --no-fund", timeout_sec=900)
        await environment.upload_dir(REPO / "container" / "profile", f"{DSH_HOME}/profiles/migrate")
        if self._skills:
            source = REPO / "vendor" / "dsh-plugin-upgrade-skill" / "skills" / SKILL
            if not (source / "SKILL.md").is_file():
                raise RuntimeError("the +skills subjects need `git submodule update --init vendor/dsh-plugin-upgrade-skill`")
            await environment.upload_dir(source, f"{SKILLS_DIR}/{SKILL}")
        await environment.upload_file(self._tarball, f"{WORK}/bot.tgz")
        await self._exec(environment, f"npm install -g --no-audit --no-fund {WORK}/bot.tgz", timeout_sec=900)
        # A session prices its usage with the bot's own accounting, found here.
        self._app_root = f"{(await self._exec(environment, 'npm root -g')).strip()}/@royenheart/dsh-migrate-action"
        # A runtime that cannot start a session fails the setup, which Harbor
        # records before the agent runs: an infrastructure failure, not a score.
        await self._exec(environment, f"DSH_BIN={DSH} DSH_HOME={DSH_HOME} dsh-migrate self-test", timeout_sec=300)

    @override
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        api_key = os.environ.get("DEEPSEEK_API_KEY")
        if not api_key:
            raise RuntimeError("DEEPSEEK_API_KEY is not set in the environment running Harbor")
        baseline = (await self._exec(environment, "git -C /app rev-parse HEAD")).strip()
        if self._subject.startswith("pipeline"):
            code, log = await self._run_pipeline(environment, api_key, context)
        else:
            code, log = await self._run_session(environment, api_key, instruction, context)
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "agent.log").write_text(log, encoding="utf-8")
        (self.logs_dir / "proposed.diff").write_text(await self._fixture_diff(environment, baseline), encoding="utf-8")
        context.metadata = {"subject": self._subject, "agent_exit_code": code}

    async def _run_session(self, environment: BaseEnvironment, api_key: str, instruction: str, context: AgentContext) -> tuple[int, str]:
        if self._skills:
            await self._exec(environment, f"mkdir -p {DSH_HOME}/skills && cp -R {SKILLS_DIR}/{SKILL} {DSH_HOME}/skills/")
        env = {
            "DEEPSEEK_API_KEY": api_key,
            "DSH_MIGRATE_PROVIDER": self._provider,
            "DSH_MIGRATE_MODEL": self._model,
            "DSH_MIGRATE_THINKING": "enabled",
            "DSH_MIGRATE_EFFORT": "max",
            "DSH_MIGRATE_TASK": instruction,
            "DSH_MIGRATE_APP_ROOT": self._app_root,
            "CI": "1",
        }
        result = await environment.exec(command=f"cd /app && {DSH} --profile migrate {shlex.quote(instruction)}", env=env)
        log = f"{result.stdout or ''}\n{result.stderr or ''}"
        status = None
        for line in log.splitlines():
            if line.strip().startswith(STATUS_PREFIX):
                status = json.loads(line.strip()[len(STATUS_PREFIX):])
        if status is not None:
            context.n_cache_tokens = int(status["cacheHitTokens"])
            context.n_input_tokens = int(status["cacheMissTokens"]) + context.n_cache_tokens
            context.n_output_tokens = int(status["outputTokens"])
            if isinstance(status.get("costUsd"), (int, float)):
                context.cost_usd = float(status["costUsd"])
        return result.return_code, log

    async def _run_pipeline(self, environment: BaseEnvironment, api_key: str, context: AgentContext) -> tuple[int, str]:
        plugin = f"{WORK}/plugin"
        target = (await self._exec(environment, "node -p \"require(require('path').join(require('child_process').execSync('npm root -g').toString().trim(), '@deepseek-ai/dsh/package.json')).version\"")).strip()
        config = {
            "secrets": {"apiKeyEnv": "DEEPSEEK_API_KEY"},
            "agent": {"provider": self._provider, "model": self._model, "upgradeSkills": self._skills},
            "checks": {"e2e": {"enabled": False}},
        }
        await self._exec(environment, (
            f"rm -rf {plugin} && cp -R /app/fixture {plugin} && rm -rf {plugin}/.git && cd {plugin} && git init -q && git add -A"
            " && git -c user.name=bench -c user.email=bench@local commit -qm baseline"
            f" && printf '%s' {shlex.quote(json.dumps(config))} > {WORK}/config.json"
        ))
        env = {"DEEPSEEK_API_KEY": api_key, "DSH_BIN": DSH, "DSH_HOME": DSH_HOME, "DSH_MIGRATE_SKILLS_DIR": SKILLS_DIR, "CI": "1"}
        options = f"--workdir {plugin} --config {WORK}/config.json"
        result = await environment.exec(command=f"dsh-migrate run {options} --target {shlex.quote(target)} --skip-github", env=env)
        status = json.loads(await self._exec(environment, f"dsh-migrate status {options}", env=env))
        (self.logs_dir / "status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
        migration = next((view for view in status["migrations"] if view["target"]["version"] == target), None)
        if migration is not None:
            events = await self._exec(environment, f"git -C {plugin} show dsh-migrate/state:migrations/{target}/events.jsonl")
            (self.logs_dir / "events.jsonl").write_text(events, encoding="utf-8")
            _add_session_usage(events, context)
        # The fixture receives what a consumer would be proposed: the tree of a
        # migration that ended `unpublished`, and nothing otherwise.
        if migration is not None and migration["state"] == "unpublished":
            # The proposed tree replaces the fixture file by file, from the
            # index of the plugin copy: a patch would not apply if anything else
            # had touched the fixture. Installed dependencies stay in place.
            await self._exec(environment, (
                f"cd {plugin} && git add -A"
                " && find /app/fixture -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +"
                " && git checkout-index -a -f --prefix=/app/fixture/"
            ))
        return result.return_code, f"{result.stdout or ''}\n{result.stderr or ''}"

    async def _fixture_diff(self, environment: BaseEnvironment, baseline: str) -> str:
        """The fixture against the baseline commit, untracked files included, without touching the index."""
        index = f"{WORK}/diff.index"
        return await self._exec(environment, (
            f"cd /app && rm -f {index} && GIT_INDEX_FILE={index} git add -A fixture"
            f" && GIT_INDEX_FILE={index} git diff --cached --binary {baseline} -- fixture"
        ))


def _add_session_usage(events: str, context: AgentContext) -> None:
    """The usage of a pipeline: the sum over its `session.done` events, counted as Harbor counts it."""
    totals = {"inputTokens": 0, "cacheHitTokens": 0, "outputTokens": 0}
    usd: float | None = None
    for line in events.splitlines():
        entry = json.loads(line)
        if entry["kind"] == "event" and entry["event"]["type"] == "session.done":
            usage = entry["event"].get("usage", {})
            for key in totals:
                totals[key] += usage.get(key, 0)
            if "usd" in usage:
                usd = (usd or 0.0) + usage["usd"]
    context.n_cache_tokens = totals["cacheHitTokens"]
    context.n_input_tokens = totals["inputTokens"] + totals["cacheHitTokens"]
    context.n_output_tokens = totals["outputTokens"]
    context.cost_usd = usd
