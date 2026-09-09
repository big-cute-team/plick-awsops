// 2D report-style diagram API: runs the live relationship queries, feeds them
// to tools/diagram/generate_diagrams.py (mingrammer + Graphviz on this host),
// and streams the PNG back.
// 2D 보고서 스타일 다이어그램 API: 라이브 쿼리 → Python 렌더러 → PNG 반환.
import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { runQuery } from '@/lib/steampipe';
import { queries as relQ } from '@/lib/queries/relationships';

// Query key -> data file name the Python script expects
const DATA_FILES: [string, string][] = [
  ['vpcSubnets', 'vpc_subnets'],
  ['ec2Relations', 'ec2'],
  ['elbRelations', 'elb'],
  ['natRelations', 'nat'],
  ['routeTables', 'route_tables'],
  ['targetGroups', 'target_groups'],
];

const SCRIPT = path.join(process.cwd(), 'tools', 'diagram', 'generate_diagrams.py');
const RENDER_TIMEOUT_MS = 90_000;

function runPython(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', [SCRIPT, ...args]);
    let out = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('diagram render timed out'));
    }, RENDER_TIMEOUT_MS);
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (out += d.toString()));
    p.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
  });
}

export async function POST(request: NextRequest) {
  let tmp: string | null = null;
  try {
    const body = await request.json();
    const vpc: string = body.vpc;
    if (!vpc || typeof vpc !== 'string') {
      return NextResponse.json({ error: 'vpc required' }, { status: 400 });
    }
    const direction = body.direction === 'LR' ? 'LR' : 'TB';
    const includeEmpty = Boolean(body.includeEmpty);
    const excludeSubnets: string[] = Array.isArray(body.excludeSubnets)
      ? body.excludeSubnets.filter((s: any) => typeof s === 'string').slice(0, 50)
      : [];
    const accountId: string | undefined = body.accountId;

    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'msdiag-'));
    for (const [qKey, fileName] of DATA_FILES) {
      const result = await runQuery((relQ as any)[qKey], { accountId });
      if (result.error) throw new Error(`query ${qKey} failed: ${result.error}`);
      await fs.writeFile(path.join(tmp, `${fileName}.json`), JSON.stringify(result.rows));
    }

    const args = [
      '--vpc', vpc,
      '--direction', direction,
      '--data-dir', tmp,
      '--outdir', tmp,
      '--out-name', 'diagram',
    ];
    if (includeEmpty) args.push('--include-empty');
    if (excludeSubnets.length) args.push('--exclude-subnets', excludeSubnets.join(','));

    const { code, out } = await runPython(args);
    if (code !== 0) throw new Error(`renderer exited ${code}: ${out.slice(-400)}`);

    const png = await fs.readFile(path.join(tmp, 'diagram.png'));
    return new NextResponse(new Uint8Array(png), {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'X-Render-Log': encodeURIComponent(out.split('\n').slice(-2).join(' | ').slice(0, 400)),
      },
    });
  } catch (err: any) {
    console.error('[Diagram] render failed:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    if (tmp) fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
