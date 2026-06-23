<?php
/******************************************************************************
 * examples/fj2me-bridge-api.php
 *
 * Tham khảo PHP client cho bridge API. Dùng để nhúng vào web hosting PHP
 * (vd: WordPress, forum, custom PHP site) để:
 *   - Liệt kê game từ Node.js bridge.
 *   - Embed game vào trang PHP thông qua iframe hoặc link.
 *   - Chia sẻ session PHPSESSID với Node.js bridge.
 *
 * Usage:
 *   require_once 'fj2me-bridge-api.php';
 *   $api = new Fj2meBridgeApi('https://fj2me.example.com', 'mysecrettoken');
 *   $games = $api->list();
 *   foreach ($games as $g) {
 *     echo "<li>{$g['name']} - <a href='run.html?app={$g['appId']}&bridge=1&gameId={$g['gameId']}'>Chơi</a></li>";
 *   }
 *****************************************************************************/

class Fj2meBridgeApi {
  private $base;
  private $secret;
  private $sessionCookie;
  private $timeout;

  public function __construct($base, $secret = '', $sessionCookie = '', $timeout = 10) {
    $this->base = rtrim($base, '/');
    $this->secret = $secret;
    $this->sessionCookie = $sessionCookie;
    $this->timeout = $timeout;
  }

  /**
   * Gọi API JSON-style (POST /bridge/fj2meweb/* hoặc GET).
   * @return array { success, data, error, meta }.
   */
  public function call($method, $path, $body = null) {
    $ch = curl_init($this->base . $path);
    $headers = ['Content-Type: application/json'];
    if ($this->secret) $headers[] = 'X-Bridge-Secret: ' . $this->secret;
    if ($this->sessionCookie) $headers[] = 'Cookie: ' . $this->sessionCookie;

    curl_setopt_array($ch, [
      CURLOPT_RETURNTRANSFER => true,
      CURLOPT_CUSTOMREQUEST => strtoupper($method),
      CURLOPT_HTTPHEADER => $headers,
      CURLOPT_TIMEOUT => $this->timeout,
      CURLOPT_FOLLOWLOCATION => false,
    ]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));

    $resp = curl_exec($ch);
    $err = curl_error($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($err) return ['success' => false, 'error' => $err, 'data' => null];
    $j = json_decode($resp, true);
    if (!is_array($j)) return ['success' => false, 'error' => 'invalid_json: ' . substr($resp, 0, 200), 'data' => null];
    return $j;
  }

  /**
   * Gọi API PHP-style (POST /bridge/api với action=...).
   * @return array { success, data, error, meta }.
   */
  public function phpApi($action, $params = []) {
    return $this->call('POST', '/bridge/api', array_merge(['action' => $action], $params));
  }

  /**
   * Đẩy game JAR + settings lên bridge.
   * @param string $appId appId của freej2me-web.
   * @param string $jarPath đường dẫn file JAR trên PHP server.
   * @param string $name tên hiển thị.
   * @param array $settings vd: ['phone' => 'Nokia', 'width' => '240', 'height' => '320', 'sound' => 'on'].
   * @return array|null { gameId, appId, name, settings, streamUrl, ... } hoặc null nếu fail.
   */
  public function pushGame($appId, $jarPath, $name = '', array $settings = []) {
    if (!file_exists($jarPath)) throw new Exception("JAR không tồn tại: $jarPath");
    $jarB64 = base64_encode(file_get_contents($jarPath));
    $body = [
      'appId' => $appId,
      'name' => $name ?: $appId,
      'jarBase64' => $jarB64,
      'settings' => $settings,
    ];
    $r = $this->call('POST', '/bridge/fj2meweb/push-game', $body);
    return ($r['success'] ?? false) ? $r['data'] : null;
  }

  /**
   * Liệt kê các game đã đẩy lên bridge.
   * @return array danh sách game.
   */
  public function listGames() {
    $r = $this->call('GET', '/bridge/fj2meweb/list');
    return ($r['success'] ?? false) ? ($r['data']['games'] ?? []) : [];
  }

  /**
   * Lấy thông tin 1 game.
   * @return array|null hoặc null nếu không tìm thấy.
   */
  public function getGame($gameId) {
    $r = $this->phpApi('get', ['gameId' => $gameId]);
    return ($r['success'] ?? false) ? $r['data'] : null;
  }

  /**
   * Spawn emulator cho game (lazy: nếu đã chạy thì return session hiện tại).
   * @return array|null { streamUrl, sessionId, status, ... }.
   */
  public function launch($gameId) {
    $r = $this->call('GET', "/bridge/fj2meweb/launch/$gameId");
    return ($r['success'] ?? false) ? $r['data'] : null;
  }

  /**
   * Xoá game khỏi bridge.
   */
  public function deleteGame($gameId) {
    $r = $this->call('DELETE', "/bridge/fj2meweb/game/$gameId");
    return $r['success'] ?? false;
  }

  /**
   * Cập nhật config per-game.
   */
  public function updateSettings($gameId, array $settings) {
    $r = $this->call('POST', "/bridge/fj2meweb/settings/$gameId", $settings);
    return ($r['success'] ?? false) ? $r['data'] : null;
  }

  /**
   * Helper: render danh sách game thành HTML (nút Play mỗi game).
   * @param array $extraClass class CSS bổ sung cho container.
   */
  public function renderGameListHtml($extraClass = 'fj2me-game-list') {
    $games = $this->listGames();
    if (empty($games)) {
      return '<p class="' . htmlspecialchars($extraClass) . '">Chưa có game nào.</p>';
    }
    $html = '<ul class="' . htmlspecialchars($extraClass) . '">';
    foreach ($games as $g) {
      $appId = htmlspecialchars($g['appId'] ?? '');
      $name = htmlspecialchars($g['name'] ?? $appId);
      $gameId = htmlspecialchars($g['gameId']);
      $playUrl = $this->base . '/run.html?app=' . urlencode($appId) . '&bridge=1&gameId=' . urlencode($gameId);
      $html .= '<li>';
      $html .= '<strong>' . $name . '</strong> ';
      $html .= '<small>(' . htmlspecialchars($appId) . ')</small> ';
      $html .= '<a href="' . htmlspecialchars($playUrl) . '" target="_blank">▶ Chơi</a>';
      $html .= '</li>';
    }
    $html .= '</ul>';
    return $html;
  }
}

/**
 * Demo usage - chỉ chạy khi file được gọi trực tiếp.
 */
if (PHP_SAPI === 'cli' && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) {
  // CLI test.
  $base = getenv('BRIDGE_BASE') ?: 'http://localhost:3000';
  $secret = getenv('BRIDGE_SECRET') ?: '';
  $api = new Fj2meBridgeApi($base, $secret);

  echo "Ping: ";
  $r = $api->phpApi('ping');
  echo ($r['success'] ?? false) ? "OK (version " . ($r['data']['bridgeVersion'] ?? '?') . ")\n" : "FAIL: " . ($r['error'] ?? '?') . "\n";

  echo "List games: ";
  $games = $api->listGames();
  echo count($games) . " game(s).\n";
  foreach ($games as $g) {
    echo "  - {$g['gameId']}  appId={$g['appId']}  name={$g['name']}  launches={$g['launchCount']}\n";
  }
}
