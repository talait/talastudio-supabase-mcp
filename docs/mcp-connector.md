# Konektor TalaStudio untuk Claude (MCP), 19 Nov 2026

## Untuk siapa
Hanya akun owner yang terdaftar di `core.settings` `access.mcp`: **ejo@talaliving.com** dan **evin@talaliving.com** (keputusan 19 Nov 2026). Akun lain yang mencoba akan ditolak di halaman izin.

## Apa yang bisa dilihat
Semua data perusahaan, **baca saja**:
- Tool James versi admin: overview, search, meaning_search, business_trace, knowledge_graph, timeline, recent, get_item, sheet_rows, list_tabs, collection_context, pc_files, staff_directory, workspace_activity, website_visitors, ai_prompts, system_log, hr_documents, past_chats (chat James milik sendiri).
- `sql_query`: SQL baca-saja ke semua skema data (sheets, media, ai, spine, biz, kg, product, cms, core, hr, qa, public, talastudio_visitor_tracker, view james), maksimal 1000 baris.
- `database_schema`: daftar tabel/kolom. `company_context`: pengetahuan perusahaan + catatan tim + kolom view james. `look_at_file`: gambar/halaman pertama PDF dikirim ke Claude untuk dilihat sendiri.

Tidak pernah keluar: kunci dan rahasia (`core.app_secrets`, `core.settings` asli, webhook alarm, rilis ekstensi/agen, QR dan kode pairing WhatsApp, URL sesi upload), serta chat James dan catatan pribadi orang lain. Nilai yang mirip kunci (JWT, sk-, AIza, private key, URL bertanda tangan) disensor di semua jawaban.

Tidak ada tool yang menulis, mengirim, menyetujui, atau menghapus.

## Cara kerja
- Server: `https://mcp.talastudio.net/mcp`, Worker Cloudflare sendiri `talastudio-supabase-mcp` (repo `talait/talastudio-supabase-mcp`), deploy otomatis lewat Workers Builds. Host ini tanpa Cloudflare Access karena yang memanggil server Claude; selain `/mcp` dan alamat OAuth, semua 404. Halaman izin tetap di workspace (repo `talait/talastudio-supabase`).
- Login: OAuth 2.1 milik workspace (registrasi dinamis + Client ID Metadata Document, PKCE S256). Langkah browser ada di `workspace.talastudio.net/oauth/consent`, di belakang Cloudflare Access (login Google akun kantor), lalu owner menekan **Izinkan akses**.
- Token akses 8 jam, refresh 60 hari (diputar; refresh lama yang dipakai ulang mematikan seluruh sesi). Disimpan hanya sebagai hash (`mcp.tokens`).
- SQL bebas berjalan lewat `mcp.owner_query` dengan peran `ts_owner_read` di dalam transaksi READ ONLY.
- Setiap panggilan tercatat di `mcp.calls` (siapa, tool, argumen, waktu, berhasil/gagal).
- Proses berpikir memakai model Claude di akun owner, jadi tidak memakai kuota 9Router.

## Memasang (oleh owner)
- **Paket Team/Enterprise:** Owner organisasi Claude: Organization settings › Connectors › Add › Custom (Web) › URL `https://mcp.talastudio.net/mcp` › Add. Anggota (ejo@/evin@): Customize › Connectors › TalaStudio › Connect.
- **Paket Pro/Max:** Customize › Connectors › Add custom connector › nama "TalaStudio", URL `https://mcp.talastudio.net/mcp` › Add › Connect.
- Saat Connect: login Google akun kantor bila diminta, lalu tekan **Izinkan akses**.
- Di chat: tombol "+" › Connectors › nyalakan TalaStudio.
- Claude Code: `claude mcp add --transport http talastudio https://mcp.talastudio.net/mcp`, lalu `/mcp` untuk login.

## Mengelola
- Tambah/hapus orang: ubah `core.settings` `access.mcp` (berlaku langsung, token akun yang dihapus langsung mati).
- Perangkat hilang: `select mcp.revoke_all('email')`.
- Riwayat pemakaian: `select * from mcp.calls order by at desc`.

## Perbaikan keamanan yang ikut
James `query_database` tidak boleh lagi memanggil fungsi skema lain (mis. `ai.hr_documents('email admin', …)`), yang sebelumnya bisa membuka dokumen HR untuk akun bukan admin.
