// Trang Chính sách quyền riêng tư — Meta yêu cầu khi đưa app Messenger lên chế độ Live
import { BRAND } from "./knowledge.js";

export const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chính sách quyền riêng tư – ${BRAND.name} Messenger</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; line-height: 1.65; color: #222; }
  h1 { font-size: 1.6rem; margin-bottom: 4px; }
  h2 { font-size: 1.15rem; margin-top: 28px; }
  .muted { color: #666; font-size: .9rem; }
  hr { border: 0; border-top: 1px solid #ddd; margin: 40px 0; }
</style>
</head>
<body>
<h1>Chính sách quyền riêng tư</h1>
<p class="muted">Trợ lý tự động trên Messenger của ${BRAND.name} · Cập nhật: 18/11/2026</p>

<h2>1. Phạm vi</h2>
<p>Chính sách này áp dụng cho trợ lý tự động trả lời tin nhắn trên Fanpage Facebook của ${BRAND.name} (công ty thiết kế và thi công xây dựng). Trợ lý chỉ hoạt động trong các cuộc trò chuyện mà bạn chủ động nhắn tin cho Fanpage.</p>

<h2>2. Thông tin chúng tôi nhận</h2>
<ul>
  <li>Nội dung tin nhắn, hình ảnh bạn gửi cho Fanpage.</li>
  <li>Mã định danh cuộc trò chuyện do Facebook cung cấp (không phải tài khoản Facebook của bạn).</li>
  <li>Thông tin bạn tự cung cấp: tên, số điện thoại, nhu cầu thiết kế/thi công, địa điểm, diện tích, ngân sách.</li>
</ul>
<p>Chúng tôi không truy cập trang cá nhân, danh sách bạn bè hay bất kỳ dữ liệu nào khác trên tài khoản Facebook của bạn.</p>

<h2>3. Mục đích sử dụng</h2>
<ul>
  <li>Trả lời câu hỏi và ghi nhận nhu cầu ban đầu của bạn.</li>
  <li>Chuyển thông tin cho kiến trúc sư của ${BRAND.name} để liên hệ tư vấn, báo giá.</li>
</ul>
<p>Chúng tôi không bán, không cho thuê và không dùng thông tin của bạn cho quảng cáo của bên thứ ba.</p>

<h2>4. Đơn vị xử lý dữ liệu</h2>
<ul>
  <li><b>Meta (Facebook Messenger)</b>: truyền tải tin nhắn.</li>
  <li><b>Cloudflare</b>: máy chủ chạy trợ lý và lưu lịch sử trò chuyện.</li>
  <li><b>Anthropic (Claude)</b>: mô hình AI soạn câu trả lời; nội dung chỉ được dùng để tạo câu trả lời.</li>
</ul>

<h2>5. Lưu trữ</h2>
<p>Lịch sử trò chuyện được lưu để trợ lý và kiến trúc sư nắm được nội dung đã trao đổi, và chỉ được giữ trong thời gian cần thiết cho việc tư vấn. Trợ lý không dùng lại nội dung các cuộc trò chuyện cũ hơn 14 ngày.</p>

<h2>6. Quyền của bạn – yêu cầu xoá dữ liệu</h2>
<p>Bạn có thể yêu cầu xem, sửa hoặc xoá thông tin của mình bất cứ lúc nào bằng cách nhắn "xoá dữ liệu" cho Fanpage hoặc gọi hotline <b>${BRAND.hotline}</b>. Chúng tôi sẽ xử lý trong vòng 7 ngày làm việc.</p>

<h2>7. Liên hệ</h2>
<p>${BRAND.name}<br>Địa chỉ: ${BRAND.address}<br>Hotline: ${BRAND.hotline}<br>Website: <a href="${BRAND.website}">${BRAND.website}</a></p>

<hr>

<h1>Privacy Policy</h1>
<p class="muted">${BRAND.name} Messenger assistant · Updated: 18 Nov 2026</p>
<p>This policy covers the automated assistant that replies to messages sent to the ${BRAND.name} Facebook Page (an architecture, design and construction company). We receive only what you send to the Page: message text, images, the conversation ID provided by Facebook, and any details you choose to share (name, phone number, project needs). We use this information solely to answer your questions and to pass your request to our architects so they can contact you. We do not sell or share your data for advertising. Data processors: Meta (message delivery), Cloudflare (hosting and conversation storage) and Anthropic (AI model that drafts replies). Conversation history is kept only as long as needed to serve your request; the assistant does not use conversations older than 14 days. To access or delete your data, message "delete my data" to the Page or call ${BRAND.hotline}; requests are handled within 7 business days.</p>
<p>Contact: ${BRAND.name}, ${BRAND.address} · Hotline ${BRAND.hotline} · <a href="${BRAND.website}">${BRAND.website}</a></p>
</body>
</html>`;
