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

  New installs start with `~/.agents/skills` and the `~/.claude` profile. Any folder can be edited or removed. Paths may start with `~` and use environment variables such as `$HOME` or `${XDG_CONFIG_HOME}`; write `$$` for a `$` that is part of a folder name. A missing folder is skipped until it exists. A folder whose variable is not set is skipped too, and sync reports it. Two entries that reach the same folder, also through a symlink (say `~/.claude/skills` linked to `~/.agents/skills`), share one set of links.
- **Suggested folders.** Settings list Claude Code config folders found on this computer that are not in the list yet: `$CLAUDE_CONFIG_DIR`, `~/.claude`, `~/.claude-<name>`, and folders named like `claude` in `~/.config` or one level below it. Nothing is added until you click **Add**, and a suggestion can be dismissed.
- **Groups.** A group is a folder inside the skills folder whose subfolders are skills; the top level is the skills folder itself. Each group goes to **all folders, including ones added later**, or to **only the selected folders**.
- **Per-skill choice.** A skill goes where its group goes, unless you set it to **Custom** and pick its folders. The choice is kept by the skill's path. If a skill with a custom choice disappears, new skills in the same folder are not linked anywhere until you either hand them the choice (**Use for …**) or forget it in settings, because a rename made outside Obsidian looks like a new skill.
- **Preview.** Turning sync on, the **Preview** button and the **Preview changes** command show every link that would be created or removed, grouped by folder, before anything is written. Edits in settings are applied when you close the settings, without a preview, so click **Preview** first to check them.
- **Live.** Creating, renaming or deleting a skill updates the links within a second. The plugin also syncs when Obsidian starts and when you close its settings.
- **Folder renames.** Renaming or moving the skills folder, a group, a skill, or their parent folders inside the vault updates the saved paths, links and per-skill choices.
- **Vault moves.** Each sync records the exact links it manages. After you rename or move the vault and reopen it, sync repairs those links if their old destinations no longer exist. Run sync once before moving the vault. Links that broke before 1.0.1 started recording them are reported as broken links the plugin did not create; delete them and sync again.

## Several Claude Code profiles

Claude Code reads skills from the `skills` folder of its config folder. If you run it with different config folders, for example `CLAUDE_CONFIG_DIR=~/.claude-personal claude`, add each one as a Claude profile and route skills to them:

1. Add the profiles: click **Add** next to a suggested folder, or **Add folder** and choose **Claude profile**. An added profile gets every group set to **All folders** when you close the settings.
2. Put the skills for one profile into a group, such as `skills/personal`, and set that group to **Only the selected folders** with just that profile checked.
3. Or set single skills to **Custom**.

Routing is set per vault: to keep the skills of one vault out of a profile, change that vault's settings. The surest ways are to turn the profile off in that vault (its links from this vault are removed and no skill goes there), or to use groups set to **Only the selected folders**, which never reach profiles added later. A **Custom** choice is tied to the skill's path, so prefer the first two for skills that must never reach a profile.

Links in profiles a skill no longer goes to are removed on the next sync. Obsidian started from the dock or start menu usually does not see variables set in your shell profile, so write the folder itself rather than `$CLAUDE_CONFIG_DIR`.

## Which agent folders

Codex, Cursor, GitHub Copilot, Gemini CLI, OpenCode and most other agents read `~/.agents/skills`. Claude Code reads only the `skills` folder of its config folder. Cursor and OpenCode read both, so they may list a skill twice. Add another folder only for an agent that reads neither: an agent that reads two linked folders lists each skill twice.

## Safety

This plugin creates and deletes symlinks **outside your vault**.

- Sync is off after install. Turning it on shows every link it will create or remove before anything is written. Later edits in settings are applied when you close the settings, without a preview; use **Preview** to check them first.
- It only removes links it made: a link named after the folder it points to, where that folder is a skill folder of this vault (directly inside a group folder, or anywhere under the skills folder), was renamed or deleted, or the link was recorded by an earlier sync. Recorded links whose old destinations no longer exist after a vault move are repaired.
- Everything else is left alone and reported with the reason when it is in the way: links into a vault nested inside this one (a folder with its own `.obsidian` folder, other than the skills folder, a group folder or a folder above them), other links into this vault (such as `project-notes` pointing at a notes folder), live links to a copied vault, links repointed elsewhere, links that reach a skill through another link, untracked broken links, and real folders and files. A folder that cannot be read is reported and left unchanged.
- On a volume that ignores letter case (the default on macOS and Windows), two skills whose names differ only in case are reported as a clash instead of failing, and the one already linked keeps its link.
- Removing a folder from the list, or changing its path, removes the links this vault recorded there on the next sync. This cleanup waits while any folder path has an unset variable.
- It never deletes or moves files, in the vault or elsewhere. The only folder it creates is a profile's `skills` folder, when you click **Create skills folder**.
- **Remove all links created by this plugin** in the command palette removes its links and turns sync off. Run it before uninstalling.

Desktop only. On Windows the links are directory junctions, which need no admin rights.

## Upgrading from 1.0

Settings keep their meaning: `~/.claude/skills` becomes the `~/.claude` profile, other folders keep their paths (a `$` in them stays part of the folder name), and groups kept out of a folder stay out of it while folders added later still get them. No links change. The settings are converted in memory and saved in the new format with the first change or sync that records links. Version 1.0 finds no folders in the new format and does nothing, so update the plugin on every device that shares this vault's `.obsidian` folder together, and keep a copy of `.obsidian/plugins/skill-symlinks/data.json` if you might go back.

## Development

```
npm install
npm run dev      # watch build into main.js
npm test
npm run lint
```

`src/sync.ts` plans link changes through a small filesystem interface, so `test/plan.test.ts` runs the planner against an in-memory filesystem; `test/sync.test.ts` covers real symlinks and `test/plugin.test.ts` the bundled plugin with Obsidian stubbed.

Release: bump `version` in `manifest.json` and `package.json`, add it to `versions.json` and `CHANGELOG.md`, and let CI pass on all three systems. Push a tag with the same version from the release branch; the workflow drafts a GitHub release with `main.js`, `manifest.json` and `styles.css`. Publish that draft, then merge the version bump into `main`. Obsidian offers an update as soon as `manifest.json` on `main` changes and downloads the files from the release with that tag, so the release must be public first.
