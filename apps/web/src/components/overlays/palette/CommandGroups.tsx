import { Command } from 'cmdk';
import type { ReactNode } from 'react';
import type { PaletteCommand } from './commands';
import { GroupHeading, IconTile, KeyHint, PaletteItem } from './items';

/**
 * 「前往」「操作」两组命令，输入为空和搜索时共用。
 * children 会排在「操作」组最前面（例如「在图库里搜索」）。
 */
export function CommandGroups({ commands, children }: { commands: PaletteCommand[]; children?: ReactNode }) {
  const nav = commands.filter((c) => c.section === 'go');
  const actions = commands.filter((c) => c.section === 'act');
  return (
    <>
      {nav.length > 0 && (
        <Command.Group heading={<GroupHeading title="前往" />}>
          {nav.map((c) => (
            <CommandRow key={c.value} command={c} />
          ))}
        </Command.Group>
      )}
      {(actions.length > 0 || children) && (
        <Command.Group heading={<GroupHeading title="操作" />}>
          {children}
          {actions.map((c) => (
            <CommandRow key={c.value} command={c} />
          ))}
        </Command.Group>
      )}
    </>
  );
}

function CommandRow({ command }: { command: PaletteCommand }) {
  return (
    <PaletteItem
      value={command.value}
      onSelect={command.run}
      leading={<IconTile icon={command.icon} />}
      title={command.label}
      trailing={
        command.meta || command.keys ? (
          <>
            {command.meta && <span>{command.meta}</span>}
            {command.keys && <KeyHint keys={command.keys} />}
          </>
        ) : undefined
      }
    />
  );
}
