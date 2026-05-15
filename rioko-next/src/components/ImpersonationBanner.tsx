import { cookies } from "next/headers";
import { Wrench, ExternalLink } from "lucide-react";

const BACKOFFICE_URL = process.env.BACKOFFICE_URL ?? "https://backoffice.rioko.pt";

export async function ImpersonationBanner() {
    const cookieStore = await cookies();
    const impersonationId = cookieStore.get("rioko_impersonate_id")?.value;
    if (!impersonationId) return null;

    return (
        <div className="sticky top-0 z-50 bg-gradient-to-r from-amber-600 via-amber-500 to-amber-600 border-b border-white/10 py-2.5 px-6 shadow-2xl flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
                <div className="bg-white/20 p-2 rounded-xl ring-1 ring-white/30">
                    <Wrench className="w-4 h-4 text-white" />
                </div>
                <div className="flex flex-col leading-tight">
                    <span className="text-[10px] font-black text-white/60 uppercase tracking-widest">
                        Modo Super-Admin · A impersonar
                    </span>
                    <span className="text-sm font-black text-white font-mono">{impersonationId.slice(0, 8)}…</span>
                </div>
            </div>
            <div className="flex items-center gap-2">
                <a
                    href={`${BACKOFFICE_URL}/superadmin/users/${impersonationId}/dev-mode`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-white text-amber-700 px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-black hover:text-white transition-all shadow-lg flex items-center gap-2"
                >
                    <Wrench className="w-3 h-3" /> Dev Mode <ExternalLink className="w-3 h-3 opacity-60" />
                </a>
                <a
                    href={`${BACKOFFICE_URL}/superadmin`}
                    className="text-white/80 hover:text-white text-[10px] font-black uppercase tracking-widest underline underline-offset-4"
                >
                    Parar
                </a>
            </div>
        </div>
    );
}
