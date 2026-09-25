# Skill Symlinks

Keep your AI agent skills in an Obsidian vault and link them into the folders agents read skills from, such as `~/.claude/skills` or `~/.agents/skills`. Edit a skill in Obsidian and every agent sees the change right away.

```
vault/skills/review/           →  ~/.claude/skills/review, ~/.agents/skills/review
vault/skills/claude-only/tdd/  →  ~/.claude/skills/tdd
```

## How it works

- **Skills folder.** Each subfolder of the skills folder is a skill. By default a folder counts only once it contains `SKILL.md`.
- **Agent folders.** The plugin finds the agent skill folders that exist on your device. You can add others. A missing folder is skipped until it exists.
- **Groups.** A group is a folder inside the skills folder whose subfolders are skills. For each group, and for the top level, choose which agent folders it links into.
- **Live.** Creating, renaming or deleting a skill updates the links within a second. The plugin also syncs when Obsidian starts and when you close its settings.

## Safety

This plugin creates and deletes symlinks **outside your vault**.

- Sync is off after install. Turning it on shows every link it will create or remove before anything is written.
- It only removes symlinks that point into this vault. Real folders and other links in agent folders are left alone and reported as skipped.
- It never deletes or moves files, in the vault or elsewhere.
- **Remove all links created by this plugin** in the command palette removes its links and turns sync off. Run it before uninstalling.

Desktop only. On Windows the links are directory junctions, which need no admin rights.

## Development

```
npm install
npm run dev      # watch build into main.js
npm test
npm run lint
```

Release: bump `version` in `manifest.json` and `package.json`, add it to `versions.json`, then push a tag with the same version. The workflow drafts a GitHub release with `main.js`, `manifest.json` and `styles.css`.
