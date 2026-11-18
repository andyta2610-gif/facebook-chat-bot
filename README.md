# H+ STUDIO — Bot trả lời tin nhắn Fanpage

Bot tự trả lời khách nhắn tin vào Fanpage H+ STUDIO bằng AI Claude, chạy 24/7 trên Cloudflare Workers.

## Bot làm gì
- Trả lời câu hỏi về dịch vụ, quy trình, phong cách, khu vực, dựa trên thông tin anh điền trong `src/knowledge.js`.
- Hỏi dần từng thông tin để lọc khách: loại công trình, địa điểm, diện tích, ngân sách, tên, SĐT.
- Nhớ nội dung đã trao đổi với từng khách trong 14 ngày.
- **Tự chuyển cho người thật** khi khách để lại SĐT, hỏi báo giá cụ thể, muốn gặp hoặc khảo sát, khiếu nại, hoặc hỏi câu bot không biết. Lúc đó bot ngừng trả lời khách này 12 giờ và báo anh qua Telegram (nếu có cài).
- **Nhân viên trả lời tay** trong hộp thư Page thì bot tự im với khách đó. Muốn bật lại bot cho khách, nhân viên gõ `#bot` vào hội thoại.
- Khách gửi ảnh hoặc bản vẽ: bot báo đã nhận, xin SĐT và báo anh vào xem.
- Lỗi AI: bot gửi câu dự phòng kèm hotline, không để khách chờ.

## Chi phí
- Cloudflare Workers + KV: **miễn phí** ở mức dùng của một Fanpage.
- Claude API: trả theo lượng dùng, cỡ vài chục đến vài trăm đồng mỗi lượt trả lời. Muốn rẻ hơn thì đổi `CLAUDE_MODEL` sang `claude-haiku-5-5` trong `wrangler.toml`.
- **Lưu ý:** API là tài khoản riêng tại console.anthropic.com, không dùng chung gói Claude anh đang dùng.

---

## Cài đặt (làm một lần, trên máy tính, khoảng 45–60 phút)

### Bước 0 — Chuẩn bị
- Cài Node.js bản LTS tại nodejs.org.
- Tạo tài khoản miễn phí tại dash.cloudflare.com.
- Tạo API key tại console.anthropic.com → API Keys, rồi nạp tiền (Billing).
- Mở Terminal (macOS) hoặc PowerShell (Windows) trong thư mục bot này, chạy:
  ```
  npm install
  npx wrangler login
  ```

### Bước 1 — Điền thông tin công ty
Mở `src/knowledge.js`, điền vào các chỗ `[ĐIỀN ...]`: website, địa chỉ, giờ làm, dịch vụ, quy trình, giá tham khảo, khu vực, câu hỏi thường gặp.
Chỗ nào chưa điền thì bot sẽ không nhắc tới, mà hẹn tư vấn viên trả lời.

### Bước 2 — Tạo kho lưu trữ (KV)
```
npx wrangler kv namespace create BOT_KV
```
Lệnh này in ra một `id`. Chép id đó vào `wrangler.toml`, thay cho `DIEN_KV_ID`.

### Bước 3 — Tạo app trên Meta
1. Vào developers.facebook.com → My Apps → **Create App** → chọn loại **Business**.
2. Trong app, thêm sản phẩm **Messenger**.
3. Mục **Access Tokens**: chọn Fanpage H+ → **Generate Token**. Lưu lại token này, đó là `PAGE_ACCESS_TOKEN`.
4. Vào **App settings → Basic**:
   - Chép **App ID** vào `wrangler.toml`, thay cho `DIEN_APP_ID`.
   - Bấm Show ở **App Secret** và lưu lại, đó là `APP_SECRET`.

### Bước 4 — Nhập các khoá bí mật
Chạy từng lệnh dưới đây, mỗi lệnh sẽ hỏi giá trị thì dán vào:
```
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put PAGE_ACCESS_TOKEN
npx wrangler secret put APP_SECRET
npx wrangler secret put VERIFY_TOKEN
```
`VERIFY_TOKEN` là một chuỗi anh tự đặt, ví dụ `hplus-2026-bimat`. Nhớ chuỗi này để dùng ở Bước 6.

### Bước 5 — Đưa bot lên mạng
```
npm run deploy
```
Lệnh này in ra địa chỉ bot, dạng `https://hplus-messenger-bot.<tên>.workers.dev`.

### Bước 6 — Nối webhook với Fanpage
Trong app Meta, vào **Messenger → Webhooks**:
- Callback URL: `https://hplus-messenger-bot.<tên>.workers.dev/webhook`
- Verify token: chuỗi anh đặt ở Bước 4
- Bấm **Verify and save**
- Ở dòng Fanpage H+, bấm **Add subscriptions** và tick: `messages`, `message_echoes`

### Bước 7 — Thử và mở cho khách thật
- Lúc này app còn ở chế độ thử, nên **chỉ admin/tester của app** nhắn vào Page thì bot mới trả lời. Anh dùng nick của mình nhắn thử nhiều tình huống.
- Khi đã ổn, gửi Meta duyệt quyền **pages_messaging** (mục App Review). Cần quay một video ngắn quay cảnh bot trả lời và điền mô tả. Sau khi được duyệt, chuyển app sang **Live** để bot trả lời mọi khách.

### (Tuỳ chọn) Nhận báo qua Telegram khi khách cần người
1. Trên Telegram, nhắn @BotFather, gõ `/newbot` để tạo bot và lấy **token**.
2. Nhắn một tin bất kỳ cho bot vừa tạo, rồi mở trên trình duyệt: `https://api.telegram.org/bot<TOKEN>/getUpdates`. Trong kết quả, tìm `"chat":{"id": ...}`, đó là chat id.
3. Chạy:
   ```
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```

---

## Vận hành hằng ngày
- **Sửa nội dung bot trả lời:** sửa `src/knowledge.js`, rồi chạy `npm run deploy`.
- **Xem bot đang chạy ra sao:** `npm run logs`.
- **Giành quyền trả lời một khách:** nhân viên cứ trả lời trong hộp thư Meta Business Suite, bot sẽ tự dừng 12 giờ. Muốn đổi số giờ, sửa `HANDOFF_HOURS` trong `wrangler.toml`.
- **Bật lại bot cho một khách:** gõ `#bot` trong hội thoại đó. Khách cũng thấy tin này, nên có thể xoá tin ngay sau khi gửi.
- **Kiểm tra mã sau khi sửa:** `npm test`.

## Quy định của Meta cần biết
- Page chỉ được trả lời khách trong **24 giờ** kể từ tin nhắn cuối của khách. Quá thời gian đó, bot và nhân viên đều bị hạn chế gửi tin. Vì vậy cần lấy SĐT của khách sớm.
- Không dùng bot để gửi tin quảng cáo hàng loạt.
