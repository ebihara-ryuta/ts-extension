chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("sidepanel.html");

  // 既に開いていれば、そのウィンドウにフォーカスするだけにする
  const wins = await chrome.windows.getAll({ populate: true });
  for (const w of wins) {
    const tab = (w.tabs || []).find((t) => t.url === url);
    if (tab) {
      await chrome.windows.update(w.id, { focused: true });
      return;
    }
  }

  // フォーカスが外れても閉じない、独立した小さいウィンドウとして開く
  await chrome.windows.create({
    url,
    type: "popup",
    width: 640,
    height: 900,
  });
});
