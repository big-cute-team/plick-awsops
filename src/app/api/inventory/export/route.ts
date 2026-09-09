// Inventory XLSX export: runs the export query set and returns a workbook with
// one sheet per resource type plus a Summary sheet. Individual query failures
// only mark their own sheet — the rest of the workbook still builds.
// 인벤토리 XLSX 내보내기: 리소스별 시트 + Summary 시트. 쿼리 실패는 해당
// 시트에만 표기하고 나머지는 정상 생성한다.
import { NextRequest, NextResponse } from 'next/server';
import ExcelJS from 'exceljs';

export const dynamic = 'force-dynamic';
import { runQuery } from '@/lib/steampipe';
import { exportSheets } from '@/lib/queries/inventory-export';

const ROW_CAP = 5000;

export async function GET(request: NextRequest) {
  try {
    const accountId = request.nextUrl.searchParams.get('accountId') || undefined;
    const wb = new ExcelJS.Workbook();
    wb.created = new Date();

    const summary = wb.addWorksheet('Summary');
    summary.columns = [
      { header: 'Resource', key: 'resource', width: 28 },
      { header: 'Count', key: 'count', width: 12 },
      { header: 'Note', key: 'note', width: 40 },
    ];
    summary.getRow(1).font = { bold: true };
    summary.addRow({ resource: 'Account', count: '', note: accountId || 'default' });
    summary.addRow({ resource: 'Generated at', count: '', note: new Date().toISOString() });
    summary.addRow({});

    for (const { sheet, sql } of exportSheets) {
      const ws = wb.addWorksheet(sheet.slice(0, 31));
      try {
        const result = await runQuery(sql, { accountId });
        if (result.error) throw new Error(result.error);
        const rows = result.rows as Record<string, any>[];
        summary.addRow({ resource: sheet, count: rows.length, note: '' });
        if (rows.length === 0) {
          ws.addRow(['(no resources)']);
          continue;
        }
        const keys = Object.keys(rows[0]);
        ws.columns = keys.map((k) => ({
          header: k,
          key: k,
          width: Math.min(Math.max(k.length + 2, 14), 44),
        }));
        ws.getRow(1).font = { bold: true };
        ws.views = [{ state: 'frozen', ySplit: 1 }];
        rows.slice(0, ROW_CAP).forEach((r) => {
          ws.addRow(
            Object.fromEntries(
              keys.map((k) => {
                const v = r[k];
                return [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v];
              })
            )
          );
        });
        if (rows.length > ROW_CAP) {
          ws.addRow([`... ${rows.length - ROW_CAP} more rows omitted (cap ${ROW_CAP})`]);
          summary.lastRow!.getCell('note').value = `capped at ${ROW_CAP} rows`;
        }
      } catch (err: any) {
        summary.addRow({ resource: sheet, count: 'ERROR', note: err.message.slice(0, 120) });
        ws.addRow([`query failed: ${err.message.slice(0, 200)}`]);
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    const date = new Date().toISOString().slice(0, 10);
    const account = accountId || 'default';
    return new NextResponse(new Uint8Array(buf as ArrayBuffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="musinsight-inventory-${account}-${date}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: any) {
    console.error('[InventoryExport] failed:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
