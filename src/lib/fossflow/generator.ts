// FossFLOW isometric model generator.
// TS port of dac-poc/generate_fossflow.py — builds a FossFLOW-importable
// model JSON from the same /api/steampipe relationship query results the
// topology map uses. Layout is computed on a logical tile grid (x = column,
// y = row) that FossFLOW renders rotated 45 degrees.
import { fossflowIcons } from './icons';

interface Row {
  [key: string]: any;
}

export interface TopologyData {
  vpcSubnets: Row[];
  ec2: Row[];
  elb: Row[];
  nat: Row[];
  routeTables: Row[];
  targetGroups: Row[];
  igw?: Row[];
  tgw?: Row[];
  rds?: Row[];
  elasticache?: Row[];
  msk?: Row[];
  opensearch?: Row[];
  lambdaVpc?: Row[];
  vpcEndpoints?: Row[];
  s3?: Row[];
  dynamodb?: Row[];
  cloudfront?: Row[];
  route53?: Row[];
}

// Layer toggles the topology chat can flip. VPC-scoped layers default to
// visible; account-global tray layers (S3/DynamoDB/CloudFront/Route53)
// default to hidden.
// 채팅이 제어하는 레이어 토글 — VPC 귀속 레이어는 기본 표시,
// 계정 전역 트레이 레이어는 기본 숨김.
export interface TopologyOptions {
  includeEmpty?: boolean;
  showIgw?: boolean;
  showTgw?: boolean;
  showRds?: boolean;
  showEgress?: boolean;
  showEks?: boolean;
  showElasticache?: boolean;
  showMsk?: boolean;
  showOpensearch?: boolean;
  showLambda?: boolean;
  showEndpoints?: boolean;
  showS3?: boolean;
  showDynamodb?: boolean;
  showCloudfront?: boolean;
  showRoute53?: boolean;
}

export interface FossflowModel {
  title: string;
  description: string;
  icons: typeof fossflowIcons;
  colors: { id: string; value: string }[];
  items: Row[];
  views: Row[];
  fitToScreen: boolean;
}

// Icons every SP tiles; label boxes span ~2 tiles, so SP=4 plus alternating
// labelHeight keeps neighboring labels from colliding.
const SP = 4;
const COLS = 3;
const GAP_SUBNET = 2;
const GAP_AZ = 3;
const LABEL_LOW = 60;
const LABEL_HIGH = 140;
const VPC_PAD = 2;

const COLORS = [
  { id: 'col-vpc', value: '#ede9fe' },
  { id: 'col-pub', value: '#dcedc8' },
  { id: 'col-prv', value: '#d0e7f5' },
  { id: 'col-alb', value: '#e2d9f3' },
  { id: 'col-eks', value: '#fcd9a8' },
  { id: 'col-ext', value: '#e7e7ee' },
  { id: 'col-edge', value: '#2563eb' },
  { id: 'col-egress', value: '#9ca3af' },
];

function shortId(rid: string | null | undefined): string {
  const s = rid || 'unknown';
  const idx = s.indexOf('-');
  return idx > 0 ? `${s.slice(0, idx)}-${s.slice(idx + 1, idx + 7)}` : s;
}

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsStr] = cidr.split('/');
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(net);
  const bits = Number(bitsStr);
  if (ipInt === null || netInt === null || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

export function listVpcs(vpcSubnets: Row[]): { vpcId: string; name: string; cidr: string }[] {
  const seen = new Map<string, { vpcId: string; name: string; cidr: string }>();
  vpcSubnets.forEach((r) => {
    if (r.vpc_id && !seen.has(r.vpc_id)) {
      seen.set(r.vpc_id, { vpcId: r.vpc_id, name: r.vpc_name || r.vpc_id, cidr: r.vpc_cidr || '' });
    }
  });
  return Array.from(seen.values());
}

export function buildFossflowModel(
  data: TopologyData,
  vpcFilter: string,
  opts: TopologyOptions = {}
): FossflowModel | null {
  const show = {
    igw: opts.showIgw !== false,
    tgw: opts.showTgw !== false,
    rds: opts.showRds !== false,
    egress: opts.showEgress !== false,
    eks: opts.showEks !== false,
    elasticache: opts.showElasticache !== false,
    msk: opts.showMsk !== false,
    opensearch: opts.showOpensearch !== false,
    lambda: opts.showLambda !== false,
    endpoints: opts.showEndpoints !== false,
    // account-global tray layers: opt-in
    s3: opts.showS3 === true,
    dynamodb: opts.showDynamodb === true,
    cloudfront: opts.showCloudfront === true,
    route53: opts.showRoute53 === true,
  };
  const vpcMeta = new Map<string, Row>();
  data.vpcSubnets.forEach((r) => {
    if (r.vpc_id && !vpcMeta.has(r.vpc_id)) vpcMeta.set(r.vpc_id, r);
  });
  const vpcId = Array.from(vpcMeta.keys()).find(
    (v) => v === vpcFilter || vpcMeta.get(v)?.vpc_name === vpcFilter
  );
  if (!vpcId) return null;
  const meta = vpcMeta.get(vpcId)!;
  const vpcName = meta.vpc_name || vpcId;
  const vpcCidr = meta.vpc_cidr || '';

  const vEc2 = data.ec2.filter((r) => r.vpc_id === vpcId && r.instance_state !== 'terminated');
  const vElb = data.elb.filter((r) => r.vpc_id === vpcId);
  const vNat = data.nat.filter((r) => r.vpc_id === vpcId);
  const vIgw = show.igw ? (data.igw || []).filter((r) => r.vpc_id === vpcId) : [];
  const vTgw = show.tgw
    ? (data.tgw || []).filter((r) => r.resource_id === vpcId && r.state !== 'deleted')
    : [];
  const vRds = show.rds ? (data.rds || []).filter((r) => r.vpc_id === vpcId) : [];
  const vCache = show.elasticache
    ? (data.elasticache || []).filter((r) => r.vpc_id === vpcId)
    : [];
  const vLambda = show.lambda
    ? (data.lambdaVpc || []).filter((r) => r.vpc_id === vpcId)
    : [];
  const vEndpoints = show.endpoints
    ? (data.vpcEndpoints || []).filter((r) => r.vpc_id === vpcId)
    : [];
  const vSubnets = data.vpcSubnets.filter((s) => s.vpc_id === vpcId && s.subnet_id);

  // ---- public/private via route tables ----
  const subnetRtb = new Map<string, Row>();
  const mainRtb = new Map<string, Row>();
  data.routeTables.forEach((rt) => {
    (rt.associations || []).forEach((a: Row) => {
      if (a.SubnetId) subnetRtb.set(a.SubnetId, rt);
      if (a.Main) mainRtb.set(rt.vpc_id, rt);
    });
  });
  const isPublic = (sid: string, mapPublic: any): boolean => {
    const rt = subnetRtb.get(sid) || mainRtb.get(vpcId);
    if (rt) return (rt.routes || []).some((r: Row) => (r.GatewayId || '').startsWith('igw-'));
    return Boolean(mapPublic);
  };

  const subnetAz = new Map<string, string>();
  vSubnets.forEach((s) => subnetAz.set(s.subnet_id, s.availability_zone || ''));
  const azSuffix = (az: string) => (az ? az.split('-').pop() : '?');
  const natLabel = (r: Row) =>
    vNat.length > 1 ? `NAT GW (${azSuffix(subnetAz.get(r.subnet_id) || '')})` : 'NAT GW';

  // ---- subnet grid (AZ x tier) ----
  const ec2InSubnet = new Map<string, Row[]>();
  vEc2.forEach((r) => {
    if (!ec2InSubnet.has(r.subnet_id)) ec2InSubnet.set(r.subnet_id, []);
    ec2InSubnet.get(r.subnet_id)!.push(r);
  });
  const natInSubnet = new Map<string, Row[]>();
  vNat.forEach((r) => {
    if (!natInSubnet.has(r.subnet_id)) natInSubnet.set(r.subnet_id, []);
    natInSubnet.get(r.subnet_id)!.push(r);
  });

  // VPC Lambdas live inside their subnets (capped per subnet to keep boxes sane)
  // VPC 람다는 소속 서브넷 안에 배치 (서브넷당 상한)
  const subnetIdsOf = (v: any): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  const LAMBDA_CAP = 6;
  const lambdaInSubnet = new Map<string, Row[]>();
  vLambda.forEach((r) => {
    const sid = subnetIdsOf(r.vpc_subnet_ids)[0];
    if (!sid) return;
    if (!lambdaInSubnet.has(sid)) lambdaInSubnet.set(sid, []);
    lambdaInSubnet.get(sid)!.push(r);
  });

  const grid = new Map<string, { public: Row[]; private: Row[] }>();
  [...vSubnets]
    .sort((a, b) =>
      `${a.availability_zone || ''}${a.subnet_id}`.localeCompare(
        `${b.availability_zone || ''}${b.subnet_id}`
      )
    )
    .forEach((s) => {
      const sid = s.subnet_id;
      if (
        !ec2InSubnet.get(sid)?.length &&
        !natInSubnet.get(sid)?.length &&
        !lambdaInSubnet.get(sid)?.length &&
        !opts.includeEmpty
      )
        return;
      const az = s.availability_zone || 'unknown';
      if (!grid.has(az)) grid.set(az, { public: [], private: [] });
      const tier = isPublic(sid, s.map_public_ip_on_launch) ? 'public' : 'private';
      grid.get(az)![tier].push(s);
    });
  // Managed data services join their AZ column as dedicated boxes.
  // AZ 귀속 매니지드 서비스는 AZ 칼럼에 전용 박스로 배치.
  interface ServiceEntry {
    id: string;
    name: string;
    icon: string;
    desc: string;
  }
  const serviceBoxesByAz = new Map<string, Map<string, ServiceEntry[]>>();
  const addServiceEntry = (az: string, boxLabel: string, entry: ServiceEntry) => {
    if (!serviceBoxesByAz.has(az)) serviceBoxesByAz.set(az, new Map());
    const boxes = serviceBoxesByAz.get(az)!;
    if (!boxes.has(boxLabel)) boxes.set(boxLabel, []);
    if (!boxes.get(boxLabel)!.some((e) => e.id === entry.id)) boxes.get(boxLabel)!.push(entry);
    if (!grid.has(az)) grid.set(az, { public: [], private: [] });
  };
  vRds.forEach((r) =>
    addServiceEntry(r.availability_zone || 'unknown', 'RDS', {
      id: `rds-${r.db_instance_identifier}`,
      name: r.db_instance_identifier,
      icon: 'aws-rds',
      desc: r.engine || '',
    })
  );
  vCache.forEach((r) =>
    addServiceEntry(r.availability_zone || 'unknown', 'ElastiCache', {
      id: `cache-${r.cache_cluster_id}`,
      name: r.cache_cluster_id,
      icon: 'aws-elasticache',
      desc: r.engine || '',
    })
  );
  if (show.msk) {
    (data.msk || []).forEach((r) => {
      const azsHit = new Set<string>();
      subnetIdsOf(r.client_subnets).forEach((sid) => {
        const az = subnetAz.get(sid);
        if (az) azsHit.add(az);
      });
      azsHit.forEach((az) =>
        addServiceEntry(az, 'MSK', {
          id: `msk-${r.cluster_name}-${az}`,
          name: r.cluster_name,
          icon: 'aws-managed-streaming-for-apache-kafka',
          desc: r.state || '',
        })
      );
    });
  }
  if (show.opensearch) {
    (data.opensearch || []).forEach((r) => {
      const azsHit = new Set<string>();
      subnetIdsOf(r.subnet_ids).forEach((sid) => {
        const az = subnetAz.get(sid);
        if (az) azsHit.add(az);
      });
      azsHit.forEach((az) =>
        addServiceEntry(az, 'OpenSearch', {
          id: `os-${r.domain_name}-${az}`,
          name: r.domain_name,
          icon: 'aws-opensearch-service',
          desc: r.engine_version || '',
        })
      );
    });
  }

  const azs = Array.from(grid.keys()).sort();

  const subnetLabel = (s: Row) => {
    const leaf = (s.subnet_name || s.subnet_id).split('/').pop();
    return `${leaf} (${s.subnet_cidr || ''})`;
  };

  // ---- ALB target resolution ----
  const subnetCidr = new Map<string, string>();
  vSubnets.forEach((s) => {
    if (s.subnet_cidr) subnetCidr.set(s.subnet_id, s.subnet_cidr);
  });
  const instIds = new Set(vEc2.map((r) => r.instance_id));
  const subnetContaining = (ip: string): string | null => {
    for (const [sid, cidr] of Array.from(subnetCidr.entries())) {
      if (ipInCidr(ip, cidr)) return sid;
    }
    return null;
  };
  const tgByLb = new Map<string, Row[]>();
  data.targetGroups.forEach((tg) => {
    (tg.load_balancer_arns || []).forEach((lb: string) => {
      if (!tgByLb.has(lb)) tgByLb.set(lb, []);
      tgByLb.get(lb)!.push(tg);
    });
  });
  const resolveTargets = (arn: string): string[] => {
    const out = new Set<string>();
    (tgByLb.get(arn) || []).forEach((tg) => {
      (tg.target_health_descriptions || []).forEach((thd: Row) => {
        const tid = thd?.Target?.Id || '';
        if (tid.startsWith('i-')) {
          if (instIds.has(tid)) out.add(tid);
        } else if (tid) {
          const sid = subnetContaining(tid);
          if (sid) {
            const cands = ec2InSubnet.get(sid) || [];
            const eks = cands.filter((c) => /eks|worker|node/i.test(c.name || ''));
            (eks.length ? eks : cands).forEach((c) => out.add(c.instance_id));
          }
        }
      });
    });
    return Array.from(out).sort();
  };

  // ---- assemble model pieces ----
  const modelItems: Row[] = [];
  const viewItems: Row[] = [];
  const connectors: Row[] = [];
  const rectangles: Row[] = [];
  const textBoxes: Row[] = [];
  let seq = 0;
  const uid = (prefix: string) => `${prefix}-${++seq}`;

  const addNode = (id: string, name: string, icon: string, x: number, y: number, desc = '', labelH?: number) => {
    modelItems.push({ id, name, icon, ...(desc ? { description: desc } : {}) });
    viewItems.push({ id, tile: { x, y }, ...(labelH ? { labelHeight: labelH } : {}) });
  };
  const addRect = (x1: number, y1: number, x2: number, y2: number, color: string) =>
    rectangles.push({ id: uid('rect'), color, from: { x: x1, y: y1 }, to: { x: x2, y: y2 } });
  const addText = (x: number, y: number, content: string, fontSize: number) =>
    textBoxes.push({ id: uid('txt'), tile: { x, y }, content: content.slice(0, 100), fontSize });
  const addConn = (
    a: string,
    b: string,
    color: string,
    style: 'SOLID' | 'DASHED' | 'DOTTED' = 'SOLID',
    label?: string,
    width = 8
  ) =>
    connectors.push({
      id: uid('conn'),
      color,
      style,
      width,
      ...(label ? { description: label } : {}),
      anchors: [
        { id: uid('anc'), ref: { item: a } },
        { id: uid('anc'), ref: { item: b } },
      ],
    });

  const nodeByInstance = new Set<string>();
  const natItemIds: string[] = [];

  // Duplicate Name tags (e.g. ASG nodes) get an instance-id suffix so they stay distinguishable
  // 동일 Name 태그(ASG 노드 등)는 인스턴스 ID 접미사로 구분
  const nameCount = new Map<string, number>();
  vEc2.forEach((r) => {
    if (r.name) nameCount.set(r.name, (nameCount.get(r.name) || 0) + 1);
  });
  const ec2Label = (r: Row) => {
    if (!r.name) return shortId(r.instance_id);
    return (nameCount.get(r.name) || 0) > 1 ? `${r.name} (${shortId(r.instance_id)})` : r.name;
  };

  // Tile positions of EC2 nodes, kept for the EKS cluster overlay
  // EKS 클러스터 오버레이용 EC2 노드 타일 좌표 기록
  const ec2Tiles = new Map<string, { x: number; y: number; cluster: string | null }>();

  const placeSubnet = (s: Row, ox: number, oy: number, tier: 'pub' | 'prv'): [number, number] => {
    const sid = s.subnet_id;
    const lambdas = (lambdaInSubnet.get(sid) || [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    const residents: ['nat' | 'ec2' | 'lambda', Row][] = [
      ...(natInSubnet.get(sid) || []).map((x): ['nat', Row] => ['nat', x]),
      ...(ec2InSubnet.get(sid) || [])
        .slice()
        .sort((a, b) => a.instance_id.localeCompare(b.instance_id))
        .map((x): ['ec2', Row] => ['ec2', x]),
      ...lambdas.slice(0, LAMBDA_CAP).map((x): ['lambda', Row] => ['lambda', x]),
    ];
    const n = Math.max(1, residents.length);
    const cols = Math.min(n, COLS);
    const rows = Math.ceil(n / COLS);
    const w = (cols - 1) * SP + 4;
    const h = (rows - 1) * SP + 4;
    addRect(ox, oy, ox + w, oy + h, tier === 'pub' ? 'col-pub' : 'col-prv');
    addText(ox, oy - 1, subnetLabel(s), 0.25);
    residents.forEach(([kind, r], i) => {
      const cx = ox + 2 + (i % COLS) * SP;
      const cy = oy + 2 + Math.floor(i / COLS) * SP;
      const lh = i % 2 ? LABEL_HIGH : LABEL_LOW;
      if (kind === 'nat') {
        const iid = r.nat_gateway_id ? `nat-${r.nat_gateway_id}` : uid('nat');
        addNode(iid, natLabel(r), 'router', cx, cy, '', lh);
        natItemIds.push(iid);
      } else if (kind === 'lambda') {
        addNode(`lambda-${r.name}`, r.name, 'aws-lambda', cx, cy, r.runtime || '', lh);
      } else {
        const iid = r.instance_id;
        addNode(iid, ec2Label(r), 'aws-ec2', cx, cy, '', lh);
        nodeByInstance.add(iid);
        ec2Tiles.set(iid, { x: cx, y: cy, cluster: r.eks_cluster || null });
      }
    });
    if (lambdas.length > LAMBDA_CAP) {
      addText(ox, oy + h + 1, `+${lambdas.length - LAMBDA_CAP} more Lambda`, 0.22);
    }
    return [w, h];
  };

  // Service box: same footprint rules as a subnet box (RDS/Cache/MSK/OpenSearch, external tray)
  const placeServiceBox = (
    label: string,
    entries: ServiceEntry[],
    ox: number,
    oy: number,
    color = 'col-prv'
  ): [number, number] => {
    const n = Math.max(1, entries.length);
    const cols = Math.min(n, COLS);
    const rows = Math.ceil(n / COLS);
    const w = (cols - 1) * SP + 4;
    const h = (rows - 1) * SP + 4;
    addRect(ox, oy, ox + w, oy + h, color);
    addText(ox, oy - 1, label, 0.25);
    entries
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((e, i) => {
        const cx = ox + 2 + (i % COLS) * SP;
        const cy = oy + 2 + Math.floor(i / COLS) * SP;
        addNode(e.id, e.name, e.icon, cx, cy, e.desc, i % 2 ? LABEL_HIGH : LABEL_LOW);
      });
    return [w, h];
  };

  // ---- lay out AZ columns inside the VPC ----
  const albRowH = vElb.length ? SP + 1 : 0;
  let azX = VPC_PAD + 1;
  const azTop = VPC_PAD + 1 + albRowH + 1;
  let maxBottom = azTop;
  azs.forEach((az) => {
    const tiers = grid.get(az)!;
    const subnets: [Row, 'pub' | 'prv'][] = [
      ...tiers.public.map((s): [Row, 'pub'] => [s, 'pub']),
      ...tiers.private.map((s): [Row, 'prv'] => [s, 'prv']),
    ];
    const azBoxes = Array.from(serviceBoxesByAz.get(az)?.entries() || []);
    let colW = 0;
    subnets.forEach(([s]) => {
      const sid = s.subnet_id;
      const n = Math.max(
        1,
        (ec2InSubnet.get(sid)?.length || 0) +
          (natInSubnet.get(sid)?.length || 0) +
          Math.min(lambdaInSubnet.get(sid)?.length || 0, LAMBDA_CAP)
      );
      colW = Math.max(colW, (Math.min(n, COLS) - 1) * SP + 4);
    });
    azBoxes.forEach(([, entries]) => {
      colW = Math.max(colW, (Math.min(entries.length, COLS) - 1) * SP + 4);
    });
    let y = azTop + 1;
    addText(azX, azTop - 1, `AZ ${az}`, 0.3);
    subnets.forEach(([s, tier]) => {
      const [, h] = placeSubnet(s, azX, y, tier);
      y += h + GAP_SUBNET;
    });
    azBoxes.forEach(([label, entries]) => {
      const [, h] = placeServiceBox(label, entries, azX, y);
      y += h + GAP_SUBNET;
    });
    maxBottom = Math.max(maxBottom, y - GAP_SUBNET);
    azX += colW + GAP_AZ;
  });

  const vpcW = Math.max(azX - GAP_AZ + VPC_PAD, 10);
  const vpcH = maxBottom + VPC_PAD - 1;

  // ALBs centered at top inside the VPC, grouped in an ingress band
  // ALB는 VPC 상단 중앙에 인그레스 밴드로 그룹핑
  const albIds: [string, Row][] = [];
  if (vElb.length) {
    const n = vElb.length;
    const albY = VPC_PAD + 1;
    const startX = Math.max(VPC_PAD + 1, Math.floor((vpcW - (n - 1) * SP) / 2));
    addRect(startX - 1, albY - 1, startX + (n - 1) * SP + 1, albY + 1, 'col-alb');
    addText(startX - 1, albY - 2, 'Load Balancer (ingress)', 0.25);
    [...vElb]
      .sort((a, b) => a.elb_name.localeCompare(b.elb_name))
      .forEach((e, i) => {
        const iid = `elb-${e.elb_name.replace(/[^A-Za-z0-9-]/g, '-')}`;
        addNode(
          iid,
          e.elb_name,
          'aws-elastic-load-balancing',
          startX + i * SP,
          albY,
          e.scheme || '',
          i % 2 ? LABEL_HIGH : LABEL_LOW
        );
        albIds.push([iid, e]);
      });
  }

  addRect(0, 0, vpcW, vpcH, 'col-vpc');
  addText(0, -1, `${vpcName} (${vpcCidr})`, 0.35);
  addNode('internet', 'Internet', 'cloud', Math.floor(vpcW / 2), -3);

  // IGW on the VPC boundary between Internet and the ALB band, labeled with its Name tag
  // IGW는 VPC 경계(Internet과 ALB 밴드 사이)에 Name 태그로 표기
  const igwId = vIgw.length ? `igw-node-${vIgw[0].internet_gateway_id}` : null;
  if (igwId) {
    addNode(igwId, vIgw[0].name || vIgw[0].internet_gateway_id, 'router', Math.floor(vpcW / 2), 0, 'Internet Gateway');
  }

  // TGW attachments on the left VPC boundary, labeled with Name tags
  // TGW 어태치먼트는 VPC 좌측 경계에 Name 태그로 표기
  vTgw.forEach((t, i) => {
    addNode(
      `tgw-node-${t.transit_gateway_attachment_id}`,
      t.name || t.transit_gateway_id,
      'aws-transit-gateway',
      0,
      Math.floor(vpcH / 2) + i * SP,
      'Transit Gateway attachment',
      i % 2 ? LABEL_HIGH : LABEL_LOW
    );
  });

  // EKS cluster overlays per contiguous node group (unshift so they render above
  // subnet sheets). One box per cluster x subnet — a whole-cluster bounding box
  // would swallow everything between the AZ columns.
  // EKS 클러스터 오버레이 — 클러스터×서브넷 단위 (전체 바운딩 박스는 AZ 사이를
  // 전부 덮어버리므로 인접 노드 그룹별로 분리)
  if (show.eks) {
    const byClusterSubnet = new Map<string, { x: number; y: number }[]>();
    vEc2.forEach((r) => {
      const t = ec2Tiles.get(r.instance_id);
      if (!t || !t.cluster) return;
      const key = `${t.cluster}|${r.subnet_id}`;
      if (!byClusterSubnet.has(key)) byClusterSubnet.set(key, []);
      byClusterSubnet.get(key)!.push(t);
    });
    byClusterSubnet.forEach((tiles, key) => {
      const cluster = key.split('|')[0];
      const xs = tiles.map((t) => t.x);
      const ys = tiles.map((t) => t.y);
      rectangles.unshift({
        id: uid('rect'),
        color: 'col-eks',
        from: { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1 },
        to: { x: Math.max(...xs) + 1, y: Math.max(...ys) + 1 },
      });
      addText(Math.min(...xs) - 1, Math.max(...ys) + 2, `EKS ${cluster}`, 0.22);
    });
  }

  // VPC endpoints on the right boundary (capped)
  // VPC 엔드포인트는 우측 경계 배치 (상한)
  const EP_CAP = 8;
  vEndpoints.slice(0, EP_CAP).forEach((e, i) => {
    const svc = (e.service_name || '').replace(/^com\.amazonaws\.[a-z0-9-]+\./, '');
    addNode(
      `vpce-${e.vpc_endpoint_id}`,
      svc || e.vpc_endpoint_id,
      'cube',
      vpcW,
      3 + i * SP,
      `${e.vpc_endpoint_type || ''} endpoint`,
      i % 2 ? LABEL_HIGH : LABEL_LOW
    );
  });
  if (vEndpoints.length > EP_CAP) {
    addText(vpcW, 3 + EP_CAP * SP, `+${vEndpoints.length - EP_CAP} more endpoints`, 0.22);
  }

  // Account-global tray right of the VPC (opt-in layers, capped per type)
  // VPC 밖 계정 전역 트레이 (opt-in 레이어, 타입별 상한)
  const TRAY_CAP = 9;
  const trayBoxes: [string, ServiceEntry[], number][] = [];
  if (show.s3 && (data.s3 || []).length) {
    const rows = data.s3!;
    trayBoxes.push([
      'S3',
      rows.slice(0, TRAY_CAP).map((r) => ({
        id: `s3-${r.name}`,
        name: r.name,
        icon: 'aws-simple-storage-service',
        desc: r.region || '',
      })),
      rows.length,
    ]);
  }
  if (show.dynamodb && (data.dynamodb || []).length) {
    const rows = data.dynamodb!;
    trayBoxes.push([
      'DynamoDB',
      rows.slice(0, TRAY_CAP).map((r) => ({
        id: `ddb-${r.name}`,
        name: r.name,
        icon: 'aws-dynamodb',
        desc: '',
      })),
      rows.length,
    ]);
  }
  if (show.cloudfront && (data.cloudfront || []).length) {
    const rows = data.cloudfront!;
    trayBoxes.push([
      'CloudFront',
      rows.slice(0, TRAY_CAP).map((r) => {
        const alias = Array.isArray(r.aliases)
          ? r.aliases[0]
          : (r.aliases as any)?.Items?.[0];
        return {
          id: `cf-${r.id}`,
          name: alias || r.domain_name || r.id,
          icon: 'aws-cloudfront',
          desc: r.id || '',
        };
      }),
      rows.length,
    ]);
  }
  if (show.route53 && (data.route53 || []).length) {
    const rows = data.route53!;
    trayBoxes.push([
      'Route 53',
      rows.slice(0, TRAY_CAP).map((r) => ({
        id: `r53-${r.name}`,
        name: (r.name || '').replace(/\.$/, ''),
        icon: 'aws-route-53',
        desc: r.private_zone ? 'private zone' : 'public zone',
      })),
      rows.length,
    ]);
  }
  if (trayBoxes.length) {
    const trayX = vpcW + 4;
    addText(trayX, 0, 'Account-global (external)', 0.3);
    let ty = 2;
    trayBoxes.forEach(([label, entries, total]) => {
      const [, h] = placeServiceBox(label, entries, trayX, ty, 'col-ext');
      if (total > entries.length) {
        addText(trayX, ty + h + 1, `+${total - entries.length} more`, 0.22);
        ty += 1;
      }
      ty += h + GAP_SUBNET;
    });
  }

  // ---- connectors ----
  const seen = new Set<string>();
  const connOnce = (
    a: string,
    b: string,
    color: string,
    style: 'SOLID' | 'DASHED' | 'DOTTED' = 'SOLID',
    label?: string,
    width = 8
  ) => {
    const key = `${a}->${b}`;
    if (seen.has(key)) return;
    seen.add(key);
    addConn(a, b, color, style, label, width);
  };
  const ingressHub = igwId || 'internet';
  if (igwId) connOnce('internet', igwId, 'col-edge', 'SOLID', 'HTTPS');
  albIds.forEach(([iid, e]) => {
    if (e.scheme === 'internet-facing')
      connOnce(ingressHub, iid, 'col-edge', 'SOLID', igwId ? undefined : 'HTTPS');
    resolveTargets(e.arn).forEach((inst) => {
      if (nodeByInstance.has(inst)) connOnce(iid, inst, 'col-edge');
    });
  });
  if (show.egress && natItemIds.length) {
    const nat0 = natItemIds[0];
    nodeByInstance.forEach((inst) => connOnce(inst, nat0, 'col-egress', 'DOTTED', undefined, 4));
    connOnce(nat0, ingressHub, 'col-egress', 'DASHED', undefined, 6);
  }

  // ---- recenter layout on the origin (initial camera looks at tile 0,0) ----
  const xs: number[] = [];
  const ys: number[] = [];
  viewItems.forEach((v) => {
    xs.push(v.tile.x);
    ys.push(v.tile.y);
  });
  textBoxes.forEach((t) => {
    xs.push(t.tile.x);
    ys.push(t.tile.y);
  });
  rectangles.forEach((r) => {
    xs.push(r.from.x, r.to.x);
    ys.push(r.from.y, r.to.y);
  });
  const dx = Math.floor((Math.min(...xs) + Math.max(...xs)) / 2);
  const dy = Math.floor((Math.min(...ys) + Math.max(...ys)) / 2);
  viewItems.concat(textBoxes).forEach((v) => {
    v.tile.x -= dx;
    v.tile.y -= dy;
  });
  rectangles.forEach((r) => {
    r.from.x -= dx;
    r.to.x -= dx;
    r.from.y -= dy;
    r.to.y -= dy;
  });

  return {
    title: `MusinSight - ${vpcName}`,
    description: `Auto-generated from Steampipe data (${vpcId}, ${vpcCidr})`,
    icons: fossflowIcons,
    colors: COLORS,
    items: modelItems,
    views: [
      {
        id: 'view-main',
        name: `${vpcName} topology`,
        items: viewItems,
        rectangles,
        connectors,
        textBoxes,
      },
    ],
    // Consumed by the page as fitToView (fossflow fits the diagram on mount)
    fitToScreen: true,
  };
}
