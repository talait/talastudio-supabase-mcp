# Konektor TalaStudio untuk Claude (MCP), 19 Nov 2026

## Untuk siapa
Semua akun Google kantor: domain di `core.settings` `access.mcp_domains` (**talaliving.com**, **talastudio.net**), plus email yang didaftarkan satu per satu di `access.mcp`. Semua mendapat akses baca penuh yang sama (keputusan 19 Nov 2026 malam; awalnya hanya ejo@ dan evin@). Email di luar domain itu ditolak di halaman izin.

## Apa yang bisa dilihat
Semua data perusahaan, **baca saja**:
- Tool James versi admin: overview, search, meaning_search, business_trace, knowledge_graph, timeline, recent, get_item, sheet_rows, list_tabs, collection_context, pc_files, staff_directory, workspace_activity, website_visitors, ai_prompts, system_log, hr_documents, past_chats (chat James milik sendiri).
- `sql_query`: SQL baca-saja ke semua skema data (sheets, media, ai, spine, biz, kg, product, cms, core, hr, qa, public, talastudio_visitor_tracker, view james), maksimal 1000 baris.
- `database_schema`: daftar tabel/kolom. `company_context`: pengetahuan perusahaan + catatan tim + kolom view james. `look_at_file`: gambar/halaman pertama PDF dikirim ke Claude untuk dilihat sendiri.

Tidak pernah keluar: kunci dan rahasia (`core.app_secrets`, `core.settings` asli, webhook alarm, rilis ekstensi/agen, QR dan kode pairing WhatsApp, URL sesi upload), serta chat James dan catatan pribadi orang lain. Nilai yang mirip kunci (JWT, sk-, AIza, private key, URL bertanda tangan) disensor di semua jawaban.

Data perusahaan tidak bisa diubah, dikirim, disetujui, atau dihapus. Yang boleh ditulis hanya konteks bersama (keputusan 20 Nov 2026):
- `remember` / `forget`: catatan tim (sama dengan catatan yang dibaca James di setiap chat) atau catatan pribadi pengguna.
- `save_file`: file yang diberikan pengguna ke Claude dan file buatan Claude disimpan apa adanya (tidak pernah ditimpa; nama sama = file baru) ke Drive `TALASTUDIO ASSETS/_CLAUDE/<nama>/<tanggal>`, tercatat di `mcp.saved_files`, lalu ikut terindeks seperti file Drive lain.
- `upload_attachment` (20 Nov): **file asli** apa pun — PDF, Excel, Word, gambar, DWG, sampai 95 MB. Claude tidak pernah memegang isi file lampiran (ia hanya melihat hasil bacaannya), jadi file asli dikirim oleh **sandbox kode Claude**, tempat lampiran itu ada sebagai file sungguhan. Tool ini memberi alamat sekali pakai `https://mcp.talastudio.net/upload/<tiket>` dan perintah `curl -T`. Claude menjalankannya, lalu Worker mengalirkan file langsung ke Drive `_CLAUDE/<nama>/<tanggal>`. File tercatat di `mcp.saved_files`, tercantum di dokumen chat-nya, dan dibaca ingestion seperti file Drive lain. Tiket berlaku untuk satu akun, satu file, 60 menit, dan yang disimpan hanya hash-nya (`mcp.upload_tickets`).
  - **Syarat otomatis:** "Code execution / Create and edit files" menyala, dan admin Claude mengizinkan domain `mcp.talastudio.net` di Organization settings > Capabilities (network egress, allowed domains). Untuk akun Pro/Max, nyalakan "Allow network egress" di Settings > Capabilities.
  - **Tanpa itu:** Claude memberi tautannya. Pengguna membukanya di browser, menjatuhkan file, dan file tetap tersimpan utuh.
- Percakapan disimpan **otomatis dan lengkap, tanpa menimpa**: setiap pemanggilan tool TalaStudio membawa pesan terakhir pengguna (`user_message`) dan jawaban Claude sebelumnya (`previous_answer`); server menambahkannya ke `mcp.chat_turns` (append-only, satu baris per pesan) dan `mcp.chats` (satu baris per percakapan, dikelompokkan lewat `Mcp-Session-Id`). `save_chat` di akhir giliran menambahkan jawaban terakhir dan ringkasan (ringkasan lama tetap ada). Salinan yang bisa dicari ada di `ai.documents` (source `ai_chat`, `claude-mcp:<chat id>`). Batasnya: pesan di giliran yang tidak memakai tool TalaStudio sama sekali tidak terekam, karena server tidak bisa membaca percakapan.

## Cara kerja
- Server: `https://mcp.talastudio.net/mcp`, Worker Cloudflare sendiri `talastudio-supabase-mcp` (repo `talait/talastudio-supabase-mcp`), deploy otomatis lewat Workers Builds. Host ini tanpa Cloudflare Access karena yang memanggil server Claude; selain `/mcp` dan alamat OAuth, semua 404. Halaman izin tetap di workspace (repo `talait/talastudio-supabase`).
- Login: OAuth 2.1 milik workspace (registrasi dinamis + Client ID Metadata Document, PKCE S256). Langkah browser ada di `workspace.talastudio.net/oauth/consent`, di belakang Cloudflare Access (login Google akun kantor), lalu pengguna menekan **Izinkan akses**.
- Token akses 8 jam, refresh 60 hari (diputar; refresh lama yang dipakai ulang mematikan seluruh sesi). Disimpan hanya sebagai hash (`mcp.tokens`).
- SQL bebas berjalan lewat `mcp.owner_query` dengan peran `ts_owner_read` di dalam transaksi READ ONLY.
- Setiap panggilan tercatat di `mcp.calls` (siapa, tool, argumen, waktu, berhasil/gagal).
- Proses berpikir memakai model Claude di akun pengguna, jadi tidak memakai kuota 9Router.

## Memasang
- **Paket Team/Enterprise:** Owner organisasi Claude: Organization settings › Connectors › Add › Custom (Web) › URL `https://mcp.talastudio.net/mcp` › Add. Anggota (ejo@/evin@): Customize › Connectors › TalaStudio › Connect.
- **Paket Pro/Max:** Customize › Connectors › Add custom connector › nama "TalaStudio", URL `https://mcp.talastudio.net/mcp` › Add › Connect.
- Saat Connect: login Google akun kantor bila diminta, lalu tekan **Izinkan akses**.
- Di chat: tombol "+" › Connectors › nyalakan TalaStudio.
- Claude Code: `claude mcp add --transport http talastudio https://mcp.talastudio.net/mcp`, lalu `/mcp` untuk login.

## Mengelola
- Siapa yang boleh: `core.settings` `access.mcp_domains` (domain) dan `access.mcp` (email satuan). Berlaku langsung: menghapus domain/email langsung mematikan token akun itu.
- Perangkat hilang: `select mcp.revoke_all('email')`.
- Riwayat pemakaian: `select * from mcp.calls order by at desc`.

## Perbaikan keamanan yang ikut
James `query_database` tidak boleh lagi memanggil fungsi skema lain (mis. `ai.hr_documents('email admin', …)`), yang sebelumnya bisa membuka dokumen HR untuk akun bukan admin.

## Pengujian (20 Nov 2026)
- Uji ujung-ke-ujung dari PC kantor sebagai `qa-bot@talaliving.com` (`app/src/sync/mcpTest.ts`): Cloudflare Access asli (token QA) → halaman izin → kode OAuth → token → semua tool, lalu token dicabut dan chat uji dihapus dari pencarian. Minta uji baru: `insert into qa.mcp_test_runs (note) values ('…')`; hasil per langkah di `qa.mcp_test_runs.results`.
- Hasil run 3: **43/43 langkah lulus** — metadata, 401/404, registrasi (redirect Claude diterima, asing ditolak), izin, PKCE salah ditolak, kode tidak bisa dipakai ulang, sesi MCP, 27 tool, tabel rahasia & chat James orang lain tertutup, tulis lewat SQL ditolak, nilai mirip kunci disensor, `look_at_file` mengirim gambar, catatan pribadi simpan/hapus, `save_file` teks & base64 ke `_CLAUDE/qa-bot/<tanggal>`, `save_chat`, percakapan tersimpan berurutan dalam satu chat, refresh token + jeda 60 detik, token baru bekerja.
- Belum teruji: sambungan dari aplikasi Claude sungguhan (Claude memakai registrasi dinamis yang sudah teruji; Client ID Metadata Document sengaja dimatikan) dan apakah Claude mengisi `user_message`/`previous_answer` di setiap tool.

- Run 6 (20 Nov): unggah file asli lulus semua (alamat sekali pakai, halaman drop, PDF masuk Drive `_CLAUDE/qa-bot/` dengan mime dan ukuran persis sama, alamat kedua kali = 410, alamat rusak = 404). Uji ini juga menemukan bug: `sql_query` ke tabel ber-RLS (ai.documents, sheets.rows, media.files, spine.events, …) menjawab 0 baris, karena kebijakannya memeriksa `core.is_staff()`. Diperbaiki dengan kebijakan `mcp_owner_read` untuk `ts_owner_read`; `hr.documents` dan `cron.*` ditutup untuk SQL (dokumen HR hanya lewat `hr_documents`).
- Run 7: **53/53 lulus**, termasuk jumlah baris > 0 di tabel ber-RLS, `hr.documents` tertutup, dan file unggahan tercantum di dokumen chat.
