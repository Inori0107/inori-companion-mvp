# INORI iPhone 小工具

在 iOS 17 以上的中尺寸 INORI 小工具點摸頭、牽手、擁抱或唱歌，互動會寫入配對的網頁房間。小工具顯示同一間房的最新互動、回覆及可用立繪。

1. 用 SideStore 安裝新版 IPA，並保留 Widget 擴充功能。從 Xcode 安裝時，App 與 Widget Target 需選同一個 Personal Team。
2. 登入正式 HTTPS 房間，進入「房間設定 → 主畫面小工具」，產生 iPhone 配對碼。複製配對資訊並貼到 INORI App，再點「配對」。配對碼五分鐘內可使用一次。
3. 回到主畫面使用中尺寸 INORI 小工具。點選動作後，在網頁「互動」頁確認同一筆紀錄和計數。伺服器未設定 OpenAI 金鑰或暫時無法生成時，會顯示房間的備用回應。
4. 要停止授權，從網頁的「主畫面小工具」撤銷 iPhone 配對。新裝置成功配對後，上一組 iPhone 憑證即失效。

部署沿用現有 Supabase 資料表及 Vercel 站點。SideStore 續簽時讓 iPhone 連上 Wi‑Fi 並開啟 LocalDevVPN。[SideStore 安裝條件](https://docs.sidestore.io/docs/installation/prerequisites)
