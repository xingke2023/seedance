'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

export default function DefaultProjectPage() {
  const router = useRouter();

  useEffect(() => {
    api.get<{ id: string }>('/projects/default')
      .then(data => {
        if (data?.id) router.replace(`/projects/${data.id}`);
      })
      .catch(() => {
        router.replace('/projects');
      });
  }, [router]);

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh', color: '#6b7280', fontSize: 14 }}>
      加载中...
    </div>
  );
}
