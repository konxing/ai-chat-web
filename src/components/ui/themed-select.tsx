'use client';

import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface ThemedSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  'aria-label'?: string;
  'aria-labelledby'?: string;
  id?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
  placeholder?: string;
  align?: 'start' | 'end';
  side?: 'top' | 'bottom';
  icon?: ReactNode;
}

// Radix reserves the empty string for placeholders. An empty value can be
// a real choice in the app, such as "关闭" or "跟随默认".
const itemPrefix = 'choice:';

export function ThemedSelect({
  value,
  options,
  onValueChange,
  disabled,
  className,
  placeholder = '请选择',
  align = 'start',
  side = 'bottom',
  icon,
  ...triggerProps
}: ThemedSelectProps) {
  const selected = options.find((option) => option.value === value);

  return (
    <Select.Root
      value={selected ? itemPrefix + value : ''}
      disabled={disabled || options.length === 0}
      onValueChange={(itemValue) => onValueChange(itemValue.slice(itemPrefix.length))}
    >
      <Select.Trigger {...triggerProps} className={cn('themed-select-trigger', className)}>
        {icon}
        <span className="min-w-0 flex-1 truncate">
          <Select.Value placeholder={placeholder}>{selected?.label}</Select.Value>
        </span>
        <Select.Icon asChild>
          <ChevronDown className="themed-select-chevron h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="themed-select-menu"
          position="popper"
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={8}
        >
          <Select.ScrollUpButton className="themed-select-scroll">
            <ChevronUp className="h-4 w-4" aria-hidden="true" />
          </Select.ScrollUpButton>
          <Select.Viewport className="p-1">
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={itemPrefix + option.value}
                disabled={option.disabled}
                className="themed-select-option"
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="themed-select-indicator">
                  <Check className="h-4 w-4" aria-hidden="true" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="themed-select-scroll">
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
