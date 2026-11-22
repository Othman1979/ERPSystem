import { InboxOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Empty } from 'antd';
import type { ReactNode } from 'react';

export function emptyCtaForList(isFiltered: boolean, noResults: string, cta: ReactNode): ReactNode {
  return isFiltered ? noResults : cta;
}

export function EmptyCta({
  description,
  actionLabel,
  onClick,
}: {
  description: string;
  actionLabel: string;
  onClick: () => void;
}) {
  return (
    <Empty image={<InboxOutlined style={{ fontSize: 36 }} />} description={description}>
      <Button type="primary" icon={<PlusOutlined />} onClick={onClick}>
        {actionLabel}
      </Button>
    </Empty>
  );
}
