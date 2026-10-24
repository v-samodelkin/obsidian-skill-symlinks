# Changelog

## 1.1.0

### Added

- Claude profiles: an agent folder can be a Claude Code config folder (`~/.claude`, or any folder used with `CLAUDE_CONFIG_DIR`), linked into its `skills` subfolder. Each agent folder has a name, and settings offer to create a missing `skills` folder in a profile.
- Suggested folders: Claude Code config folders found on this computer are listed with an **Add** button. Nothing is added automatically, and suggestions can be dismissed.
- Routing: each group goes to all folders, including ones added later, or only to the selected folders. A single skill can override its group with its own folders.
- When a skill with its own folders disappears (for example renamed outside Obsidian), new skills next to it are held back, linked nowhere, until its choice is handed to one of them or forgotten in settings.
- Environment variables (`$NAME`, `${NAME}`) in folder paths, and `$$` for a `$` that is part of a folder name. A folder whose variable is not set is skipped and reported in notices and the preview.
- **Preview** button and **Preview changes** command: a dry run of the next sync, grouped by folder.
- Removing a folder from the list, or changing its path, removes the links recorded there on the next sync.
- Notices and the preview name the folder each change belongs to, and skipped entries say why, including links that already reach the skill through another link and broken links the plugin did not create.

### Changed

- New installs start with `~/.agents/skills` and the `~/.claude` profile. Every folder, including the defaults, can now be edited or removed.
- Two folders that reach the same place, also through a symlink, share one set of links instead of failing or undoing each other.
- Links the plugin owns are narrower: a link named after the folder it points to, where that folder is a skill folder of this vault, is gone, or the link was recorded. Links into a vault nested inside this one and other hand-made links into the vault are left alone. A `.obsidian` folder in the skills folder, a group folder or a folder above them does not make them a nested vault.
- On volumes that ignore letter case, skills whose names differ only in case are reported as a clash, and the one already linked keeps its link. A case-only rename is relinked in one sync.
- A folder that cannot be read is reported and left unchanged, and its recorded links are kept.
- Removing one folder in settings removes only the links in that folder.
- Settings are stored in a new format (version 2), written with the first change or sync record rather than on load. Settings from 1.0 are converted without changing any links: `~/.claude/skills` becomes the `~/.claude` profile, other folders keep their paths (a `$` in a path that 1.0 could link into stays part of the folder name), and group exclusions stay exclusions. Version 1.0 finds no folders in the new format and does nothing.

## 1.0.2

- Windows: compare junction paths consistently, so links are recognised across path spellings.

## 1.0.1

- Follow renames and moves of the skills folder, groups and their parent folders.
- Record managed links, so they are repaired after the vault is renamed or moved.

## 1.0.0

- First release: link vault skill folders into agent skill folders, with groups and a preview before sync is turned on.
