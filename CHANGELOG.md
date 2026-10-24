# Changelog

## 1.1.0

### Added

- Claude profiles: an agent folder can be a Claude Code config folder (`~/.claude`, or any folder used with `CLAUDE_CONFIG_DIR`), linked into its `skills` subfolder. Each agent folder has a name, and settings offer to create a missing `skills` folder in a profile.
- Suggested folders: Claude Code config folders found on this computer are listed with an **Add** button. Nothing is added automatically, and suggestions can be dismissed.
- Routing: each group goes to all folders, including ones added later, or only to the selected folders. A single skill can override its group with its own folders.
- Environment variables (`$NAME`, `${NAME}`) in folder paths. A folder whose variable is not set is skipped.
- **Preview** button and **Preview changes** command: a dry run of the next sync, grouped by folder.
- Removing a folder from the list, or changing its path, removes the links recorded there on the next sync.
- Notices and the preview name the folder each change belongs to, and skipped entries say why, including links that already reach the skill through another link and broken links the plugin did not create.

### Changed

- New installs start with `~/.agents/skills` and the `~/.claude` profile. Every folder, including the defaults, can now be edited or removed.
- Two folders that resolve to the same place share one set of links instead of failing.
- Settings are stored in a new format (version 2). Settings from 1.0 are converted on first load without changing any links: `~/.claude/skills` becomes the `~/.claude` profile, other folders keep their paths, and group exclusions stay exclusions. Version 1.0 cannot read the new format.

## 1.0.2

- Windows: compare junction paths consistently, so links are recognised across path spellings.

## 1.0.1

- Follow renames and moves of the skills folder, groups and their parent folders.
- Record managed links, so they are repaired after the vault is renamed or moved.

## 1.0.0

- First release: link vault skill folders into agent skill folders, with groups and a preview before sync is turned on.
