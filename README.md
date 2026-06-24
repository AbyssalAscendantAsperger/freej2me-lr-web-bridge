# FreeJ2ME-Plus (Web-Oriented Fork)

> **Một bản fork tập trung vào việc biến FreeJ2ME-Plus thành một nền tảng headless có khả năng chạy đa người dùng.**

Đây là bản fork của [TASEmulators/freej2me-plus](https://github.com/TASEmulators/freej2me-plus) với định hướng hoàn toàn khác: thay vì tối ưu cho RetroArch hay GUI truyền thống, phiên bản này được thiết kế để dễ dàng tích hợp vào các ứng dụng web và backend.

---

## Tại sao cần bản fork này?

Hầu hết các giải pháp J2ME trên trình duyệt hiện nay đều đi theo hướng **transpile** (CheerpJ, J2ME.js, v.v.). Những giải pháp này có ưu điểm là chạy hoàn toàn trên client, nhưng lại có giới hạn nghiêm trọng về độ tương thích.

FreeJ2ME-Plus vốn dĩ là một máy ảo Java ME thực thụ, có khả năng chạy được rất nhiều game phức tạp mà các giải pháp browser-based không thể làm được. Tuy nhiên, bản gốc được thiết kế chủ yếu để chạy như một ứng dụng desktop hoặc core RetroArch.

Bản fork này được tạo ra với mục tiêu duy nhất: **biến FreeJ2ME-Plus thành một thành phần có thể nhúng được** vào các hệ thống backend/web.

---

## Điểm khác biệt lớn so với upstream

Thay vì mỗi người dùng phải chạy một JVM riêng (rất tốn RAM), bản fork này giới thiệu **kiến trúc Multi-Session Isolation**.

### Kiến trúc cũ (upstream)
```
User 1 → JVM 1 (200MB+) + Game
User 2 → JVM 2 (200MB+) + Game
...
→ RAM tăng tuyến tính theo số người chơi
```

### Kiến trúc mới (fork)
```
User 1 ─┐
User 2 ─┼─→ Single JVM + Session Isolation + Shared Resources
User 3 ─┘
→ RAM chủ yếu chỉ tăng theo kích thước game, không phải theo số JVM
```

Kết quả thực tế: **giảm đáng kể RAM overhead** khi chạy nhiều game đồng thời cho nhiều người dùng.

---

## Tính năng chính đã thêm

- **LibretroEmbeddedSession**: Chạy emulator ở chế độ headless hoàn toàn, không phụ thuộc AWT.
- **FrameSink / AudioSink abstraction**: Cho phép đẩy frame và âm thanh ra bất kỳ nơi nào (WebSocket, file, bộ nhớ...).
- **Queue-based & Stream-based sinks**: Hỗ trợ cả chế độ queue (kiểm soát backpressure) và stream.
- **Multi-session lifecycle management**: Mỗi session có thể được khởi tạo, reset, và dọn dẹp độc lập.
- **AudioPipe**: Xuất âm thanh theo định dạng packet dễ dàng tiêu thụ từ bên ngoài.
- **WebSocket transport layer** (tùy chọn): Đã có sẵn lớp hỗ trợ giao tiếp hai chiều.

---

## Use case phù hợp

Bản fork này đặc biệt phù hợp với những ai muốn:

- Xây dựng **thư viện game J2ME** trên web (đặc biệt là các game hiếm, vendor-specific).
- Tạo nền tảng **cloud gaming** nhẹ cho J2ME.
- Chạy hàng trăm game đồng thời trên một server mà không tốn quá nhiều RAM.
- Tích hợp J2ME vào các hệ thống backend hiện có (Node.js, Go, Python...).

**Lưu ý quan trọng**: Đây không phải là giải pháp "chạy cho hàng nghìn người dùng cùng lúc". Nó phù hợp với mô hình có **hàng đợi** và **giới hạn concurrent session** hợp lý.

---

## Cách sử dụng

### 1. Chạy game ở chế độ Headless (cơ bản)

```java
import org.recompile.freej2me.session.LibretroEmbeddedSession;
import org.recompile.mobile.Mobile;

public class BasicHeadlessExample {
    public static void main(String[] args) {
        // Khởi tạo session
        LibretroEmbeddedSession session = new LibretroEmbeddedSession(
            "/path/to/game.jar",
            240, 320,           // resolution
            0,                  // phone type
            60                  // fps
        );

        // Đăng ký nhận frame
        session.setFrameSink(frame -> {
            // frame là byte[] hoặc BufferedImage tùy implementation
            System.out.println("Received frame: " + frame.length + " bytes");
        });

        // Chạy game
        session.start();

        // Sau 10 giây thì dừng
        try { Thread.sleep(10000); } catch (Exception ignored) {}
        session.stop();
    }
}
```

### 2. Nhận cả Frame + Audio (Stream mode)

```java
import org.recompile.freej2me.session.*;
import org.recompile.mobile.AudioPipe;

LibretroEmbeddedSession session = new LibretroEmbeddedSession(jarPath, 240, 320, 0, 60);

// Nhận frame
session.setFrameSink(new StreamFrameSink() {
    @Override
    public void onFrame(byte[] frameData) {
        // Gửi frame sang WebSocket hoặc xử lý tiếp
        websocket.sendBinary(frameData);
    }
});

// Nhận audio
session.setAudioSink(new StreamAudioSink() {
    @Override
    public void onAudio(byte[] audioData, int format) {
        // audioData theo định dạng AudioPipe
        websocket.sendBinary(audioData);
    }
});

session.start();
```

### 3. Sử dụng Queue mode (khuyến nghị cho web)

```java
import org.recompile.freej2me.session.QueueFrameSink;
import org.recompile.freej2me.session.QueueAudioSink;

QueueFrameSink frameQueue = new QueueFrameSink(5);   // giữ tối đa 5 frame
QueueAudioSink audioQueue = new QueueAudioSink(10);  // giữ tối đa 10 packet audio

session.setFrameSink(frameQueue);
session.setAudioSink(audioQueue);

// Trong thread riêng hoặc event loop
while (session.isRunning()) {
    byte[] frame = frameQueue.poll();   // non-blocking hoặc dùng take()
    byte[] audio = audioQueue.poll();

    if (frame != null) {
        // Xử lý frame
    }
    if (audio != null) {
        // Xử lý audio
    }
}
```

### 4. Xử lý Input từ Web

```java
import org.recompile.freej2me.session.InputSource;

InputSource input = session.getInputSource();

// Gửi phím
input.keyPress(0x35);        // phím 5 (Fire)
input.keyRelease(0x35);

// Gửi touch (nếu game hỗ trợ)
input.touchDown(120, 200);
input.touchMove(125, 205);
input.touchUp();
```

### 5. Ví dụ tích hợp với Node.js (WebSocket)

**Server.js (Node.js)**

```js
const WebSocket = require('ws');
const { spawn } = require('child_process');

const wss = new WebSocket.Server({ port: 3000 });

wss.on('connection', (ws) => {
    // Khởi động Java process với session
    const java = spawn('java', [
        '-cp', 'freej2me-plus.jar:lib/*',
        'org.recompile.freej2me.WebSocketMain',
        ws._socket.remoteAddress
    ]);

    java.stdout.on('data', (data) => {
        // Nhận frame/audio từ Java
        ws.send(data);
    });

    ws.on('message', (msg) => {
        // Gửi input từ client về Java
        java.stdin.write(msg);
    });

    ws.on('close', () => {
        java.kill();
    });
});
```

**Java side** (WebSocketMain.java - đã có trong fork):

```java
// org.recompile.freej2me.transport.WebSocketMain
public class WebSocketMain {
    public static void main(String[] args) {
        String clientId = args[0];
        LibretroEmbeddedSession session = new LibretroEmbeddedSession(...);
        
        WebSocketSession wsSession = new WebSocketSession(clientId);
        session.setFrameSink(wsSession::sendFrame);
        session.setAudioSink(wsSession::sendAudio);
        
        // Lắng nghe input từ WebSocket
        wsSession.setInputListener(session.getInputSource());
        
        session.start();
    }
}
```

---

## Cấu hình mẫu (config.json)

```json
{
  "comment": "Cấu hình cho web bridge",
  "javaPath": "../jdk8u492-b09-jre/bin/java.exe",
  "freej2meJar": "../freej2me-plus",
  "defaultGameJar": null,
  "width": 240,
  "height": 320,
  "phoneType": 0,
  "rotate": 0,
  "fps": 60,
  "sound": 1,
  "maxFps": 30,
  "port": 3000,
  "maxConcurrentSessions": 8,
  "sessionTimeoutMs": 300000,
  "enableAudioPipe": true
}
```

---

## Quản lý tài nguyên & Chống rò rỉ

Bản fork đã được thiết kế với một số cơ chế bảo vệ:

- Mỗi session có vòng đời rõ ràng (`start()` → `stop()` → `cleanup()`).
- Tự động dọn dẹp khi session bị timeout.
- Hỗ trợ `Queue*Sink` để tránh tràn bộ nhớ khi client chậm.
- Khuyến nghị **luôn gọi `session.stop()`** khi người dùng ngắt kết nối.

---

## Lời kết

Bản fork này được tạo ra vì tôi tin rằng FreeJ2ME-Plus là một trong những core J2ME mạnh nhất hiện nay, nhưng nó xứng đáng được sử dụng theo cách linh hoạt hơn — đặc biệt là trong môi trường web và backend.

Tôi hy vọng trong tương lai upstream có thể hỗ trợ hướng phát triển này. Trong lúc chờ đợi, tôi sẽ tiếp tục duy trì bản fork này để phục vụ những ai cần một giải pháp J2ME thực thụ trên web.

Nếu bạn đang xây dựng một nền tảng lưu trữ hoặc phát hành game J2ME hiếm, bản fork này có thể là một lựa chọn đáng cân nhắc.

---

**License**: Giữ nguyên license của upstream (GPLv3)

**Liên hệ / Đóng góp**: Mở issue trên repo này.