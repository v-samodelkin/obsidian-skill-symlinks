# Skill Symlinks

Keep your AI agent skills in an Obsidian vault and link them into the folders agents read skills from, such as `~/.claude/skills` or `~/.agents/skills`. Edit a skill in Obsidian and every agent sees the change right away. Choose which skills go to which agent, including separate Claude Code profiles.

```
vault/skills/review/           →  ~/.claude/skills/review, ~/.agents/skills/review
vault/skills/claude-only/tdd/  →  ~/.claude/skills/tdd
vault/skills/personal/notes/   →  ~/.claude-personal/skills/notes
```

## Install

In Obsidian, open **Settings → Community plugins → Browse**, search for **Skill Symlinks**, then install and enable it.

You can also install it with [BRAT](https://obsidian.md/plugins?id=obsidian42-brat) using `v-samodelkin/obsidian-skill-symlinks`.

## How it works

- **Skills folder.** Each subfolder of the skills folder is a skill. By default a folder counts only once it contains `SKILL.md`.
- **Agent folders.** Links go into a list of folders, each with a name and an on/off switch. There are two kinds:
  - a **Claude profile** is a Claude Code config folder, `~/.claude` by default. Links go into its `skills` subfolder. If the profile has no `skills` folder yet, settings offer to create it.
  - a **skills folder** is linked into directly, such as `~/.agents/skills`.

  New installs start with `~/.agents/skills` and the `~/.claude` profile. Any folder can be edited or removed. Paths may start with `~` and use environment variables such as `$HOME` or `${XDG_CONFIG_HOME}`. A missing folder, or one whose variable is not set, is skipped.
- **Suggested folders.** Settings list Claude Code config folders found on this computer that are not in the list yet: `$CLAUDE_CONFIG_DIR`, `~/.claude`, `~/.claude-<name>`, and folders named like `claude` in `~/.config` or one level below it. Nothing is added until you click **Add**, and a suggestion can be dismissed.
- **Groups.** A group is a folder inside the skills folder whose subfolders are skills; the top level is the skills folder itself. Each group goes to **all folders, including ones added later**, or to **only the selected folders**.
- **Per-skill choice.** A skill goes where its group goes, unless you set it to **Custom** and pick its folders.
- **Preview.** Turning sync on, the **Preview** button and the **Preview changes** command show every link that would be created or removed, grouped by folder, before anything is written.
- **Live.** Creating, renaming or deleting a skill updates the links within a second. The plugin also syncs when Obsidian starts and when you close its settings.
- **Folder renames.** Renaming or moving the skills folder, a group, a skill, or their parent folders inside the vault updates the saved paths, links and per-skill choices.
- **Vault moves.** Each sync records the exact links it manages. After you rename or move the vault and reopen it, sync repairs those links if their old destinations no longer exist. Run sync once before moving the vault. Links that broke before 1.0.1 started recording them are reported as broken links the plugin did not create; delete them and sync again.

## Several Claude Code profiles

Claude Code reads skills from the `skills` folder of its config folder. If you run it with different config folders, for example `CLAUDE_CONFIG_DIR=~/.claude-personal claude`, add each one as a Claude profile and route skills to them:

1. Add the profiles: click **Add** next to a suggested folder, or **Add folder** and choose **Claude profile**.
2. Put the skills for one profile into a group, such as `skills/personal`, and set that group to **Only the selected folders** with just that profile checked.
3. Or set single skills to **Custom**.

Links in profiles a skill no longer goes to are removed on the next sync. Obsidian started from the dock or start menu usually does not see variables set in your shell profile, so write the folder itself rather than `$CLAUDE_CONFIG_DIR`.

## Which agent folders

Codex, Cursor, GitHub Copilot, Gemini CLI, OpenCode and most other agents read `~/.agents/skills`. Claude Code reads only the `skills` folder of its config folder. Cursor and OpenCode read both, so they may list a skill twice. Add another folder only for an agent that reads neither: an agent that reads two linked folders lists each skill twice.

## Safety

This plugin creates and deletes symlinks **outside your vault**.

- Sync is off after install. Turning it on shows every link it will create or remove before anything is written.
- It only removes symlinks that point into this vault, or recorded links whose old destinations no longer exist after a vault move. Live links to a copied vault, links repointed outside this vault, links that reach a skill through another link, and untracked broken links are left alone and reported with the reason. Real folders are never replaced.
- Removing a folder from the list, or changing its path, removes the links this vault recorded there on the next sync. This cleanup waits while any folder path has an unset variable.
- It never deletes or moves files, in the vault or elsewhere. The only folder it creates is a profile's `skills` folder, when you click **Create skills folder**.
- **Remove all links created by this plugin** in the command palette removes its links and turns sync off. Run it before uninstalling.

Desktop only. On Windows the links are directory junctions, which need no admin rights.

## Upgrading from 1.0

Settings are converted on first load and keep their meaning: `~/.claude/skills` becomes the `~/.claude` profile, other folders keep their paths, and groups kept out of a folder stay out of it while folders added later still get them. No links change. Version 1.0 cannot read the converted settings, so keep a copy of `.obsidian/plugins/skill-symlinks/data.json` if you might go back.

## Development

```
npm install
npm run dev      # watch build into main.js
npm test
npm run lint
```

`src/sync.ts` plans link changes through a small filesystem interface, so `test/plan.test.ts` runs the planner against an in-memory filesystem; `test/sync.test.ts` covers real symlinks and `test/plugin.test.ts` the bundled plugin with Obsidian stubbed.

Release: bump `version` in `manifest.json` and `package.json`, add it to `versions.json` and `CHANGELOG.md`, then push a tag with the same version. The workflow drafts a GitHub release with `main.js`, `manifest.json` and `styles.css`.
