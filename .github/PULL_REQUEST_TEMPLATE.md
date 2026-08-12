<!-- One topic per PR, squash-merged. See CONTRIBUTING.md. -->

**What is the problem?**
<!-- The situation this addresses, not just the change. -->

**How does this solve it?**
<!-- And why it belongs in whydiff (scope: a local, self-contained review map). -->

**Checklist**
- [ ] `make check` passes (contract, version guard, unit + Playwright)
- [ ] Tests added/updated for changed behaviour
- [ ] `CHANGELOG.md` entry added
- [ ] If this ships (`templates/`, `agents/`, `skills/`, `schema/`, `hooks/`, `scripts/`): version bumped with `make bump BUMP=<patch|minor|major>`
- [ ] README/docs updated if user-facing
