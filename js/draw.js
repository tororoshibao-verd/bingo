// 進行役の画面。game.js が番号とビンゴを計算し、BingoStore がタブ間の排他と保存を受け持つ。
(() => {
    const STORE = BingoStore;
    const WAIT_MS = 2000; // 抽選を保存してから、未応答カードを代替照合するまでの時間。
    const ROLL_STEPS = 12;
    const ROLL_STEP_MS = 80;
    const byId = id => document.getElementById(id);
    const commandIds = ["issue-card", "start-game", "draw-next", "end-game", "reset-game"];
    let displayed = null;
    let releaseHost = null;
    let lockError = null;
    let busy = false;
    let cancelShuffle;
    let notice = "";
    let deadlineTimer;
    let refreshTimer;
    let refreshAll = false;
    const changedIds = new Set();

    function setText(selector, value) {
        for (const element of document.querySelectorAll(selector)) {
            if (element.textContent !== String(value)) element.textContent = value;
        }
    }

    function message(value) {
        setText("#host-message", value);
        byId("host-message").hidden = !value;
    }

    function disableCommands() {
        for (const id of commandIds) byId(id).disabled = true;
    }

    function showFailure(error) {
        cancelShuffle?.();
        clearTimeout(deadlineTimer);
        disableCommands();
        message(error.message || "保存内容を読み込めませんでした。ページを再読み込みしてください。");
    }

    function setProgress(id, done, total) {
        const progress = byId(id);
        progress.max = Math.max(1, total);
        progress.value = done;
        progress.textContent = `${done} / ${total}`;
        progress.setAttribute("aria-valuetext", `${total}枚中${done}枚`);
        progress.style.setProperty("--segment", `${100 / Math.min(20, progress.max)}%`);
    }

    function element(tag, content, className) {
        const node = document.createElement(tag);
        node.textContent = content;
        if (className) node.className = className;
        return node;
    }

    function letter(number) {
        return number ? "BINGO"[Math.floor((number - 1) / 15)] : "";
    }

    // 演出専用の候補からランダムに表示する。実際に引いた番号は最後にだけ見せる。
    function shuffleNumbers(pickedNumber) {
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
        if (reducedMotion.matches) return true;

        const preview = byId("draw-preview");
        const previewLetter = byId("preview-letter");
        const previewNumber = byId("preview-number");
        const previewNumbers = createNumberPool().filter(number => number !== pickedNumber);
        preview.hidden = false;
        byId("draw-label").textContent = "抽選中";

        return new Promise(resolve => {
            const finishAt = performance.now() + ROLL_STEPS * ROLL_STEP_MS;
            let timer;
            function finish(completed) {
                clearTimeout(timer);
                cancelShuffle = null;
                resolve(completed);
            }
            function tick() {
                const msLeft = finishAt - performance.now();
                if (msLeft <= 0 || reducedMotion.matches || previewNumbers.length === 0) {
                    finish(true);
                    return;
                }
                const index = Math.floor(Math.random() * previewNumbers.length);
                const [number] = previewNumbers.splice(index, 1);
                previewLetter.textContent = letter(number);
                previewNumber.textContent = number;
                timer = setTimeout(tick, Math.min(ROLL_STEP_MS, msLeft));
            }
            cancelShuffle = () => finish(false);
            tick();
        });
    }

    // 同じ内容ならリストを作り直さない。カードの通知が続いてもリンクのキーボードフォーカスが残る。
    function displayLists(game, cards) {
        const last = displayed;
        const newGame = last?.gameId !== game.gameId;
        const ids = cards.map(card => card.cardId);
        if (newGame || JSON.stringify(last.links) !== JSON.stringify(ids)) {
            const links = ids.map(id => {
                const link = element("a", `${id} を開く`);
                link.href = STORE.cardUrl(game.gameId, id);
                link.target = "_blank";
                link.rel = "noopener";
                const item = document.createElement("li");
                item.append(link);
                return item;
            });
            byId("card-links").replaceChildren(...links);
            byId("issued-links").hidden = !links.length;
            if (newGame) byId("issued-links").open = false;
        }
        if (newGame || last.round !== game.history.length) {
            byId("draw-history").replaceChildren(...game.history.map(n =>
                element("li", String(n).padStart(2, "0"), "ball-" + letter(n).toLowerCase())));
            byId("history-empty").hidden = game.history.length > 0;
        }

        const winners = JSON.stringify(game.winners);
        if (newGame || last.winners !== winners) {
            const names = new Map();
            for (const card of game.participants) {
                const name = card.displayName || card.cardId;
                names.set(name, (names.get(name) || 0) + 1);
            }
            // 保存順は初ビンゴの回順。画面では最新回を先頭にし、同着の全員を同じ大きさで見せる。
            let announcement = "";
            const items = game.winners.slice().reverse().map((group, index) => {
                const item = document.createElement("li");
                item.append(element("span", `第${group.firstBingoAt}回`, "badge"));
                if (group.cards.length > 1) item.append(element("span", `${group.cards.length}人同着`, "host-caption"));
                const labels = group.cards.map(card => {
                    const name = card.displayName || card.cardId;
                    return names.get(name) > 1 && name !== card.cardId ? `${name}（${card.cardId}）` : name;
                });
                const list = element("div", "", "winner-names");
                for (const label of labels) list.append(element("strong", label, "winner-name"));
                item.append(list);
                if (index === 0) {
                    item.className = "latest-winners";
                    announcement = `第${group.firstBingoAt}回でビンゴ。 ${labels.join("、")}`;
                }
                return item;
            });
            setText("#winner-announcement", announcement);
            // 終了後の成績表は、最初に当選した回から順に振り返れるようにする。
            byId("result-winners").replaceChildren(...items.map(item => item.cloneNode(true)).reverse());
            byId("winner-list").replaceChildren(...items);
            byId("winners-empty").hidden = byId("result-empty").hidden = items.length > 0;
        }
        displayed = {gameId: game.gameId, round: game.history.length, links: ids, winners};
    }

    function issuedCards(game) {
        return game.issuedIds.map(id => {
            const card = STORE.readCard(game.gameId, id);
            if (!card) throw new Error(`${id} の発行記録が見つかりません。保存内容を確認してください。`);
            return card;
        });
    }

    function countChecks(game) {
        const reported = game.checks.filter(check => check.status === "card-confirmed").length;
        const fallback = game.checks.filter(check => check.status === "fallback-confirmed").length;
        return {reported, fallback, pending: game.participants.length - reported - fallback};
    }

    // 描画は必ず保存後。番号・当選者・ボタンの可否を、同じ回の保存値からまとめて作る。
    function render(game) {
        clearTimeout(deadlineTimer);
        const host = STORE.hasHost();
        setText("#host-role", host ? "進行役" : "閲覧中");
        if (lockError) {
            showFailure(lockError);
            return;
        }
        if (!game) {
            displayed = null;
            disableCommands();
            message("進行役の画面でゲームを準備しています。");
            return;
        }
        const prepare = game.phase === "prepare";
        const live = game.phase === "playing";
        const cards = prepare ? issuedCards(game) : game.participants;
        const registered = prepare ? cards.filter(card => card.registered).length : cards.length;
        const {reported, fallback, pending} = countChecks(game);
        const checked = reported + fallback;
        const total = game.participants.length;
        const latest = game.history.at(-1);
        const round = game.history.length;
        document.body.dataset.view = live ? (pending ? "checking" : "draw") : game.phase;

        setText(".js-registered-count", registered);
        setText("#issued-count", game.issuedIds.length);
        setText("#registration-pending", game.issuedIds.length - registered);
        setText("#registration-summary", cards.length
            ? `発行した${game.issuedIds.length}枚のうち、${game.issuedIds.length - registered}枚が登録待ちです。`
            : "カードを発行して参加者を受け付けましょう。");
        setProgress("registration-progress", registered, game.issuedIds.length);
        setText(".js-round", round);
        setText(".js-latest-letter", letter(latest));
        setText(".js-latest-number", latest ?? "―");
        setText("#remaining-balls", game.numbers.length);
        setText("#draw-next", game.numbers.length ? "次の番号を引く" : "75球すべて抽選済み");
        setText(".js-player-count", total);
        setText("#checked-total, #final-checked-total", checked);
        setText("#verifying-reported, #reported-count", reported);
        setText("#verifying-fallback, #final-fallback, #fallback-count", fallback);
        setText("#verifying-pending, #final-pending, #pending-count", pending);
        setText("#check-summary, #final-summary", `第${round}回まで、残り${pending}枚の結果を照合しています。`);
        setProgress("check-progress", checked, total);
        setProgress("final-progress", checked, total);
        const winnerCount = game.winners.reduce((n, group) => n + group.cards.length, 0);
        setText("#winner-count", winnerCount);
        setText("#result-summary", `第${round}回で終了。参加${total}枚のうち${winnerCount}枚がビンゴしました。`);

        displayLists(game, cards);
        byId("issue-card").disabled = !host || busy || !prepare;
        byId("start-game").disabled = !host || busy || !prepare;
        byId("draw-next").disabled = !host || busy || !live || pending > 0 || !game.numbers.length;
        byId("end-game").disabled = !host || busy || !live;
        byId("reset-game").disabled = !host || busy || game.phase !== "finished";

        const problems = game.checks.filter(check => check.status === "unconfirmed" && check.reason !== waiting);
        const reasons = problems.map(check => `${check.cardId}：${check.reason}`);
        if (!host) reasons.push("ほかの抽選画面が進行中です。その画面を閉じると、ここで操作できます。");
        if (notice) reasons.push(notice);
        message(reasons.join(" "));
        const waitingForReply = game.checks.length < total || game.checks.some(check => check.reason === waiting);
        if (host && (live || game.phase === "final") && pending && (waitingForReply || Date.now() < game.deadline)) {
            deadlineTimer = setTimeout(() => scheduleRefresh(), Math.max(0, game.deadline - Date.now()) + 1);
        }
    }

    const waiting = "対象回までの確認報告を待っています。";

    function evaluateCard(game, card, allowFallback) {
        let result;
        try {
            // 参加締切時に固定した配置と、現在の保存先の両方を確認する。欠損したカードを「外れ」にしない。
            const saved = STORE.readCard(game.gameId, card.cardId);
            if (!saved?.registered || saved.displayName !== card.displayName
                || JSON.stringify(saved.cardRows) !== JSON.stringify(card.cardRows)) {
                throw new Error("参加時のカードと保存情報が一致しません。");
            }
            const report = STORE.readReport(game.gameId, card.cardId);
            result = checkCardReport(card, game.history, report, {allowFallback});
        } catch (error) {
            result = {status: "unconfirmed", reason: error.message};
        }
        return {gameId: game.gameId, cardId: card.cardId, ...result};
    }

    // 本人報告の通知は変更されたカードだけ再計算。復帰・締切時には全件を読み直して取りこぼしを拾う。
    function reconcile(game, ids = null) {
        if (game.phase !== "playing" && game.phase !== "final") return;
        const previous = new Map(game.checks.map(check => [check.cardId, check]));
        const expired = Date.now() >= game.deadline;
        const checks = game.participants.map(card => {
            const cached = previous.get(card.cardId);
            if (ids && cached && !ids.has(card.cardId) && !(expired && cached.status === "unconfirmed")) return cached;
            return evaluateCard(game, card, expired);
        });
        const changed = JSON.stringify(checks) !== JSON.stringify(game.checks);
        game.checks = checks;
        if (changed) {
            // 前の回に確定した当選は、今回の報告待ちでも表示を続ける。同じIDは game.js がまとめる。
            const earlier = game.winners.flatMap(group => group.cards.map(card => ({
                ...card, hasBingo: true, firstBingoAt: group.firstBingoAt, status: "card-confirmed",
            })));
            game.winners = groupBingoWinners([...earlier, ...checks]);
        }
        let save = changed;
        if (countChecks(game).pending === 0) {
            const round = game.history.length;
            const summary = {
                round,
                reported: checks.filter(c => c.status === "card-confirmed").map(c => c.cardId),
                fallback: checks.filter(c => c.status === "fallback-confirmed").map(c => c.cardId),
            };
            if (JSON.stringify(game.rounds.at(-1)) !== JSON.stringify(summary)) {
                if (game.rounds.at(-1)?.round === round) game.rounds.pop();
                game.rounds.push(summary);
                save = true;
            }
            if (game.phase === "final") {
                game.phase = "finished";
                game.deadline = null;
                save = true;
            }
        }
        if (save) STORE.writeGame(game);
    }

    // 関連する通知を短くまとめる。待機期限のタイマーと通知が重なっても保存は共有の鍵の中で直列に行う。
    function scheduleRefresh(id) {
        if (id) changedIds.add(id);
        else refreshAll = true;
        if (refreshTimer !== undefined) return;
        refreshTimer = setTimeout(async () => {
            refreshTimer = undefined;
            const ids = refreshAll ? null : new Set(changedIds);
            refreshAll = false;
            changedIds.clear();
            try {
                if (STORE.hasHost()) {
                    await STORE.withWrite(() => {
                        if (!STORE.hasHost()) return;
                        const game = STORE.initialGame();
                        reconcile(game, ids);
                    });
                }
                render(STORE.readGame());
            } catch (error) {
                showFailure(error);
            }
        }, 16);
    }

    // ボタンを押したときに見ていたゲームIDと回を控える。ロックの待機中に別の状態になったら操作を取り消す。
    async function command(event) {
        const id = event.currentTarget.id;
        if (busy || !displayed || !STORE.hasHost() || event.detail > 1 || byId(id).disabled) return;
        const expected = displayed;
        const leaseAtClick = releaseHost;
        function readExpectedGame() {
            const game = STORE.readGame();
            if (releaseHost !== leaseAtClick || !STORE.hasHost() || !game
                || game.gameId !== expected.gameId || game.history.length !== expected.round) {
                throw new Error("ゲームまたは操作権が変わりました。現在の状態を確認してください。");
            }
            return game;
        }
        let popup;
        let beforeDraw;
        let draw;
        busy = true;
        notice = "";
        disableCommands();
        try {
            // ユーザーのクリック中にタブを確保し、発行が保存できてからカードURLへ移る。
            if (id === "issue-card") {
                popup = window.open("about:blank", "_blank");
                if (popup) popup.opener = null;
            }
            if (id === "draw-next") {
                // 1球だけ仮決定する。演出中は鍵を持たず、プールも履歴も書き換えない。
                beforeDraw = readExpectedGame();
                if (beforeDraw.phase !== "playing" || countChecks(beforeDraw).pending || !beforeDraw.numbers.length) return;
                draw = drawOne(beforeDraw.numbers, beforeDraw.history);
                const completed = await shuffleNumbers(draw.pickedNumber);
                if (!completed) return;
            }
            await STORE.withWrite(() => {
                const game = readExpectedGame();
                if (id === "issue-card" && game.phase === "prepare") {
                    const cardId = STORE.issueCard(game);
                    if (popup && !popup.closed) popup.location.replace(STORE.cardUrl(game.gameId, cardId));
                    else {
                        byId("issued-links").open = true;
                        notice = `${cardId} を発行しました。「発行したカードを開く」から開けます。`;
                    }
                    return;
                }
                if (id === "start-game" && game.phase === "prepare") {
                    // 登録処理と同じ鍵を使うため、締切時点の参加者と盤面を一度に固定できる。
                    game.participants = issuedCards(game).filter(card => card.registered);
                    game.phase = "playing";
                    game.deadline = Date.now() + WAIT_MS;
                } else if (id === "end-game" && game.phase === "playing") {
                    game.phase = "final"; // この状態を先に保存する。待機中の引き直しは以後できない。
                } else if (id === "draw-next" && game.phase === "playing") {
                    reconcile(game);
                    if (countChecks(game).pending || !game.numbers.length) return;
                    // 鍵を取って再確認する。同じプール・履歴なら、仮決定した1球をここで初めて共有する。
                    if (JSON.stringify(game.numbers) !== JSON.stringify(beforeDraw.numbers)
                        || JSON.stringify(game.history) !== JSON.stringify(beforeDraw.history)) {
                        throw new Error("抽選の途中で保存内容が変わりました。現在の番号を確認してください。");
                    }
                    game.numbers = draw.nextNumbers;
                    game.history = draw.nextHistory;
                    game.checks = [];
                    game.deadline = Date.now() + WAIT_MS;
                } else if (id === "reset-game" && game.phase === "finished") {
                    STORE.resetGame(game.gameId);
                    return;
                } else {
                    throw new Error("この操作の受付は終了しました。");
                }
                STORE.writeGame(game);
            });
        } catch (error) {
            if (popup && !popup.closed && popup.location.href === "about:blank") popup.close();
            notice = error.message;
        } finally {
            busy = false;
            if (id === "draw-next") {
                byId("draw-preview").hidden = true;
                byId("draw-label").textContent = "最新の番号";
            }
            try { render(STORE.readGame()); }
            catch (error) { showFailure(error); }
            scheduleRefresh();
        }
    }

    for (const id of commandIds) byId(id).addEventListener("click", command);

    STORE.subscribe(change => {
        if (change.gameId && displayed && change.gameId !== displayed.gameId && change.type !== "game") return;
        scheduleRefresh(change.cardId);
    });
    function connect() {
        if (!releaseHost) {
            lockError = null;
            releaseHost = STORE.holdHost(scheduleRefresh, scheduleRefresh, error => {
                lockError = error;
                showFailure(error);
            });
        }
        scheduleRefresh();
    }
    window.addEventListener("pageshow", connect);
    window.addEventListener("pagehide", () => {
        cancelShuffle?.();
        releaseHost?.();
        releaseHost = null;
        clearTimeout(deadlineTimer);
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
    });
    window.addEventListener("focus", () => scheduleRefresh());
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) scheduleRefresh();
    });
    connect();
})();
