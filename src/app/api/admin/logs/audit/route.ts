import { api } from '@/lib/http';
import { requireOwner } from '@/lib/auth';
import { listAuditLogs, parseLogFilters } from '@/lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return api(async () => {
    await requireOwner(req);
    return listAuditLogs(parseLogFilters(new URL(req.url)));
  });
}
