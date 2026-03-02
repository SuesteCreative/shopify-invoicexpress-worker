export const runtime = 'edge';

import Link from 'next/link';

export default function NotFound() {
    return (
        <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4 text-center">
            <h2 className="text-4xl font-black text-white mb-4">404 - Não Encontrado</h2>
            <p className="text-slate-400 mb-8 max-w-md">
                A página que procuras não existe ou foi movida.
            </p>
            <Link
                href="/"
                className="px-6 py-3 bg-sky-500 hover:bg-sky-400 text-white font-bold rounded-2xl transition-all"
            >
                Voltar ao Início
            </Link>
        </div>
    );
}
