# Universal Skill Catalog

A curated set of skills for the work AI agents do across projects: writing,
planning, finding tools, coding, and checking results. Download the collection
with one command, at fixed versions, and choose which skills your agent uses.

The same catalog can supply a personal agent setup or a team setup. Each source
stays in its original repository; this catalog records what to include and which
version to download.

[catalog.json](catalog.json) lists 19 skills from five sources:

| Source | Purpose | Download ID |
| --- | --- | --- |
| [Humanizer](https://github.com/blader/humanizer) | Edit AI-sounding prose | `humanizer` |
| [Superpowers](https://github.com/obra/superpowers) | 15 workflows for planning, coding, debugging, testing, and review | `superpowers` |
| [Karpathy Guidelines](https://github.com/multica-ai/andrej-karpathy-skills) | Keep coding changes focused and check assumptions | `karpathy-guidelines` |
| [There's a Tool for That](https://github.com/kwonzweig/there-is-a-tool-for-that) | Find existing tools before building one | `tiatft-find-tools` |
| [Vercel find-skills](https://github.com/vercel-labs/skills) | Find and install additional skills | `vercel-find-skills` |

## Download

Requires Node.js 22+ and Git. No npm packages are needed.

```sh
git clone https://github.com/kwonzweig/universal-skill-catalog.git
cd universal-skill-catalog
node scripts/materialize.mjs --output ../skill-bundle
```

To download only selected sources:

```sh
node scripts/materialize.mjs --output ../writing-skills --sources humanizer,tiatft-find-tools
```

Selecting Superpowers downloads all 15 of its listed skills.

The output contains:

```text
skill-bundle/
  skills/<name>/SKILL.md   # Each skill and its supporting files
  licenses/               # Available upstream license files
  catalog.json            # Source repositories and exact commits
  receipt.json            # Downloaded files and SHA-256 hashes
```

An identical rerun leaves the output unchanged. Use a new output directory when
changing versions or selections; the script refuses to overwrite different files.

## Use a skill

Open a downloaded skill's `SKILL.md` and check its setup requirements. Copy the
whole skill folder, including supporting files, into your agent's skills directory.
For example, to use Humanizer in one project:

| Agent | Destination in your project |
| --- | --- |
| [Codex](https://learn.chatgpt.com/docs/build-skills) | `.agents/skills/humanizer/` |
| [Claude Code](https://code.claude.com/docs/en/skills) | `.claude/skills/humanizer/` |

Start a new session and ask the agent to use Humanizer to edit a paragraph.
Check for an existing copy before installing; to remove a manually installed skill,
delete the folder you copied.

The download script does not configure plugins, hooks, or agent instructions.
For the complete Superpowers setup, follow its
[installation guide](https://github.com/obra/superpowers#installation).

## Make changes

Edit the source commits or skill paths in `catalog.json`, run `npm test`, and
download to a new directory to inspect the result. Proposals for new skills
should explain how they help across projects.

Report security issues through [private vulnerability reporting](https://github.com/kwonzweig/universal-skill-catalog/security/advisories/new).

## License

This catalog and downloader use the [MIT license](LICENSE). Downloaded skills
retain their upstream licenses and notices. The pinned Karpathy Guidelines
declare MIT in `SKILL.md` but do not include a separate license file.
