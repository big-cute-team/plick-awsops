'use client';

import { useState, useEffect, useCallback, useMemo, Suspense } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import Header from '@/components/layout/Header';
import { queries as relQ } from '@/lib/queries/relationships';
import { useAccountContext } from '@/contexts/AccountContext';
import { buildFossflowModel, listVpcs, TopologyData } from '@/lib/fossflow/generator';

// FossFLOW touches `document` at module scope — client-only import.
const Isoflow = dynamic(() => import('fossflow'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-sm text-gray-400">Loading…</div>
  ),
});

function TopologyViewContent() {
  const { t } = useLanguage();
  const { currentAccountId } = useAccountContext();
  const searchParams = useSearchParams();
  const [data, setData] = useState<Record<string, { rows?: any[] }>>({});
  const [loading, setLoading] = useState(true);
  const [vpc, setVpc] = useState<string>(searchParams.get('vpc') || '');
  const [includeEmpty, setIncludeEmpty] = useState(searchParams.get('empty') === '1');

  const fetchData = useCallback(
    async (bustCache = false) => {
      setLoading(true);
      try {
        const res = await fetch(bustCache ? '/api/steampipe?bustCache=true' : '/api/steampipe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: currentAccountId,
            queries: {
              vpcSubnets: relQ.vpcSubnets,
              ec2: relQ.ec2Relations,
              elb: relQ.elbRelations,
              nat: relQ.natRelations,
              routeTables: relQ.routeTables,
              targetGroups: relQ.targetGroups,
              igw: relQ.igwRelations,
              tgw: relQ.tgwRelations,
              rds: relQ.rdsRelations,
            },
          }),
        });
        setData(await res.json());
      } catch {
      } finally {
        setLoading(false);
      }
    },
    [currentAccountId]
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const topology: TopologyData = useMemo(
    () => ({
      vpcSubnets: data.vpcSubnets?.rows || [],
      ec2: data.ec2?.rows || [],
      elb: data.elb?.rows || [],
      nat: data.nat?.rows || [],
      routeTables: data.routeTables?.rows || [],
      targetGroups: data.targetGroups?.rows || [],
      igw: data.igw?.rows || [],
      tgw: data.tgw?.rows || [],
      rds: data.rds?.rows || [],
    }),
    [data]
  );

  const vpcs = useMemo(() => listVpcs(topology.vpcSubnets), [topology]);

  // URL ?vpc= wins on first load; afterwards fall back to the first VPC found.
  const activeVpc = vpc || vpcs[0]?.vpcId || '';

  const model = useMemo(
    () => (activeVpc ? buildFossflowModel(topology, activeVpc, { includeEmpty }) : null),
    [topology, activeVpc, includeEmpty]
  );

  return (
    <div className="p-6 space-y-4 animate-fade-in">
      <Header
        title={t('topologyView.title')}
        subtitle={t('topologyView.subtitle')}
        onRefresh={() => fetchData(true)}
      />

      <div className="flex items-center gap-3">
        <select
          value={activeVpc}
          onChange={(e) => setVpc(e.target.value)}
          className="bg-navy-800 border border-navy-600 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent-cyan"
          aria-label={t('topologyView.selectVpc')}
        >
          {vpcs.length === 0 && <option value="">{t('topologyView.selectVpc')}</option>}
          {vpcs.map((v) => (
            <option key={v.vpcId} value={v.vpcId}>
              {v.name} ({v.cidr})
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={includeEmpty}
            onChange={(e) => setIncludeEmpty(e.target.checked)}
            className="accent-cyan-400"
          />
          Empty subnets
        </label>
        {loading && <span className="text-xs text-accent-cyan animate-pulse">Loading...</span>}
      </div>

      <div
        className="bg-white rounded-lg border border-navy-600 overflow-hidden"
        // Canvas labels inherit `color` — pin dark text so the dashboard's
        // dark-theme white text doesn't wash out labels on the white canvas.
        style={{ height: 'calc(100vh - 240px)', color: '#1f2937' }}
      >
        {model ? (
          // Remount on model identity change — FossFLOW only reads initialData once.
          <Isoflow
            key={`${currentAccountId}:${activeVpc}:${includeEmpty}`}
            initialData={{ ...(model as any), fitToView: true }}
            editorMode="EDITABLE"
          />
        ) : (
          !loading && (
            <div className="flex items-center justify-center h-full text-sm text-gray-500">
              {t('topologyView.empty')}
            </div>
          )
        )}
      </div>
    </div>
  );
}

export default function TopologyViewPage() {
  return (
    <Suspense>
      <TopologyViewContent />
    </Suspense>
  );
}
