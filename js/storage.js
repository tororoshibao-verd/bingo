// 保存とタブ間の通知をまとめる窓口。画面はこの中のキーを直接書き換えない。
// 進行役が使い続ける鍵と、全タブが短時間だけ借りる書き込み用の鍵を分ける。
const BingoStore = (() => {
    const prefix = "bonbon-bingo:";
    const pointerKey = prefix + "current";
    let hostLease = null;
    let writing = false;
    let validatedProgress = null;

    function requireLocks() {
        if (!navigator.locks) {
            throw new Error("タブ間の操作を安全に同期できません。HTTPS または localhost で開いてください。");
        }
        return navigator.locks;
    }

    function holdHost(onAcquire, onRelease, onError) {
        const controller = new AbortController();
        const token = {};
        let release;
        // すでに進行役がいれば順番待ちする。タブが閉じるとブラウザが次のタブに鍵を渡す。
        const released = new Promise((resolve) => { release = resolve; });
        Promise.resolve().then(() => requireLocks().request(prefix + "host", {
            signal: controller.signal,
        }, async () => {
            hostLease = token;
            try {
                await onAcquire();
                await released;
            } finally {
                if (hostLease === token) hostLease = null;
                onRelease?.();
            }
        })).catch((error) => {
            if (error.name !== "AbortError") onError(error);
        });
        return () => {
            // pagehide 中に古いタブの保留処理が進んでも、以降の保存は拒否する。
            if (hostLease === token) hostLease = null;
            controller.abort();
            release();
        };
    }

    async function withWrite(callback) {
        return requireLocks().request(prefix + "write", async () => {
            writing = true;
            try {
                // 読む → 最新状態を確認する → 保存する。待ち時間や画面操作は鍵の外で行う。
                return callback();
            } finally {
                writing = false;
            }
        });
    }

    function requireWriter(hostOnly = false) {
        if (!writing) throw new Error("書き込み用の鍵を取得してください。");
        if (hostOnly && !hostLease) throw new Error("このタブには進行役の操作権がありません。");
    }

    function read(key, isProgress = false) {
        let raw;
        try {
            raw = localStorage.getItem(key);
        } catch {
            throw new Error("ブラウザの設定で保存データを読み込めません。");
        }
        if (raw === null) return null;
        let record;
        try {
            record = JSON.parse(raw);
            if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error();
        } catch {
            throw new Error("保存データが壊れています。内容を読み込めません。");
        }
        // 同じJSONを何度読み直しても、全回分の整合確認は1回で足りる。
        // 画面に渡すオブジェクト自体は毎回新しく読み戻すので、未保存の編集は混ざらない。
        if (isProgress && validatedProgress !== raw) {
            validateGame(record);
            validatedProgress = raw;
        }
        return record;
    }

    function save(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            if (error.name === "QuotaExceededError") {
                throw new Error("ブラウザの保存容量が不足しています。空き容量を確認して再試行してください。");
            }
            throw new Error("データを保存できません。ブラウザの保存設定を確認してください。");
        }
    }

    function validId(id) {
        return typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id);
    }

    function gamePrefix(gameId) {
        if (!validId(gameId)) throw new Error("ゲームIDが正しくありません。");
        return prefix + "game:" + gameId + ":";
    }

    function cardKey(type, gameId, cardId) {
        if (!validId(cardId)) throw new Error("カードIDが正しくありません。");
        return gamePrefix(gameId) + type + ":" + cardId;
    }

    function readPointer() {
        const pointer = read(pointerKey);
        if (!pointer) return null;
        if (!validId(pointer.gameId) || (pointer.preparing !== undefined && pointer.preparing !== true)
            || (pointer.previous != null && (!pointer.preparing || !validId(pointer.previous)
                || pointer.previous === pointer.gameId))) {
            throw new Error("現在のゲームを示す保存情報が壊れています。");
        }
        return pointer;
    }

    function validateGame(game) {
        if (!validId(game.gameId) || !["prepare", "playing", "final", "finished"].includes(game.phase)
            || !Array.isArray(game.issuedIds) || !Array.isArray(game.participants) || !Array.isArray(game.checks)
            || !Array.isArray(game.winners) || !Array.isArray(game.rounds)
            || !Number.isSafeInteger(game.revision) || game.revision < 0) {
            throw new Error("ゲームの進行情報が壊れています。");
        }
        const active = game.phase === "playing" || game.phase === "final";
        if (active ? !Number.isSafeInteger(game.deadline) || game.deadline <= 0 : game.deadline !== null) {
            throw new Error("確認待ちの期限がゲームの進行状態と一致しません。");
        }
        if (!Array.isArray(game.numbers) || !Array.isArray(game.history)
            || validateBallList([...game.numbers, ...game.history], "保存した球").size !== BINGO_BALL_COUNT) {
            throw new Error("保存した残り球と抽選履歴を合わせても75球になりません。");
        }
        const issued = new Set(game.issuedIds);
        const players = new Set();
        if (game.phase === "prepare" && (game.history.length || game.participants.length || game.rounds.length
            || game.checks.length || game.winners.length)) throw new Error("準備中のゲームに抽選後の記録があります。");
        if (issued.size !== game.issuedIds.length || !game.issuedIds.every(validId)) {
            throw new Error("保存した発行済みカードIDが壊れています。");
        }
        for (const card of game.participants) {
            if (card?.gameId !== game.gameId || !issued.has(card.cardId) || players.has(card.cardId)) {
                throw new Error("参加カードの名簿が壊れています。");
            }
            players.add(card.cardId);
        }
        const checked = new Set();
        for (const check of game.checks) {
            if (check?.gameId !== game.gameId || !players.has(check.cardId) || checked.has(check.cardId)
                || !["unconfirmed", "card-confirmed", "fallback-confirmed"].includes(check.status)) {
                throw new Error("保存したカードの確認状況が壊れています。");
            }
            if (check.status !== "unconfirmed") {
                validateReport(check, game.gameId, check.cardId);
                if (check.checkedDrawCount !== game.history.length || typeof check.displayName !== "string") {
                    throw new Error("カードの確認回数または表示名が正しくありません。");
                }
            } else if (typeof check.reason !== "string" || game.phase === "finished") {
                throw new Error("保存した未確認カードの情報が正しくありません。");
            }
            checked.add(check.cardId);
        }
        // 全員を照合するたびに第0回から順に1件ずつ保存する。最新回だけは確認待ちの場合がある。
        if (game.rounds.length < game.history.length || game.rounds.length > game.history.length + 1
            || (game.phase === "finished" && (checked.size !== players.size || game.rounds.length !== game.history.length + 1))) {
            throw new Error("完了した抽選回の確認記録が足りません。");
        }
        for (const [index, row] of game.rounds.entries()) {
            if (row?.round !== index || !Array.isArray(row.reported) || !Array.isArray(row.fallback)) {
                throw new Error("抽選回ごとの確認記録が壊れています。");
            }
            const ids = [...row.reported, ...row.fallback];
            if (ids.length !== players.size || new Set(ids).size !== players.size || !ids.every(id => players.has(id))) {
                throw new Error("抽選回ごとの確認記録が参加カードと一致しません。");
            }
        }
        let previousRound = 0;
        const winners = new Set();
        for (const group of game.winners) {
            if (!Number.isInteger(group?.firstBingoAt) || group.firstBingoAt <= previousRound
                || group.firstBingoAt > game.history.length || !Array.isArray(group.cards)
                || group.cards.length === 0) {
                throw new Error("保存した当選者一覧が壊れています。");
            }
            for (const card of group.cards) {
                if (card?.gameId !== game.gameId || !players.has(card.cardId) || winners.has(card.cardId)
                    || typeof card.displayName !== "string") throw new Error("当選者の登録情報が壊れています。");
                winners.add(card.cardId);
            }
            previousRound = group.firstBingoAt;
        }
    }

    function readGame() {
        const pointer = readPointer();
        if (!pointer) return null;
        if (pointer.preparing) throw new Error("ゲームの切り替え中です。進行役の画面から再開してください。");
        const game = read(gamePrefix(pointer.gameId) + "progress", true);
        if (game?.gameId !== pointer.gameId) throw new Error("現在のゲームの進行情報が見つかりません。");
        return game;
    }

    function currentGame(gameId) {
        const game = readGame();
        if (game?.gameId !== gameId) throw new Error("ゲームが切り替わりました。画面を確認してください。");
        return game;
    }

    // リセットは複数キーにまたがる。先に切り替え中の印を記録し、途中で閉じても次の進行役が続きを行う。
    function finishPreparation(pointer) {
        const key = gamePrefix(pointer.gameId) + "progress";
        let game = read(key);
        if (!game) {
            game = {
                gameId: pointer.gameId, phase: "prepare", revision: 0,
                issuedIds: [], participants: [], numbers: createNumberPool(), history: [],
                checks: [], winners: [], rounds: [], deadline: null,
            };
            try {
                save(key, game);
            } catch (error) {
                // 新しい75球を保存できなければ旧ゲームを案内し続ける。旧データの削除はまだ行っていない。
                if (pointer.previous) save(pointerKey, { gameId: pointer.previous });
                else localStorage.removeItem(pointerKey);
                throw error;
            }
        }
        validateGame(game);
        if (game.gameId !== pointer.gameId || game.phase !== "prepare") {
            throw new Error("切り替え先ゲームの保存情報が正しくありません。");
        }
        if (pointer.previous) {
            const obsolete = gamePrefix(pointer.previous);
            // 削除するとキーの並びが変わる場合がある。旧ゲームのキーを集めてから消す。
            const oldKeys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const oldKey = localStorage.key(i);
                if (oldKey?.startsWith(obsolete)) oldKeys.push(oldKey);
            }
            for (const oldKey of oldKeys) localStorage.removeItem(oldKey);
        }
        save(pointerKey, { gameId: pointer.gameId });
        return game;
    }

    function prepareGame(previous) {
        const pointer = { gameId: crypto.randomUUID(), preparing: true, previous };
        save(pointerKey, pointer);
        return finishPreparation(pointer);
    }

    function initialGame() {
        requireWriter(true);
        const pointer = readPointer();
        if (pointer?.preparing) return finishPreparation(pointer);
        if (pointer) return readGame();
        // 開催中のゲームへの案内だけ消えた場合は、新規として上書きしない。
        for (let i = 0; i < localStorage.length; i++) {
            if (localStorage.key(i)?.startsWith(prefix + "game:")) {
                throw new Error("保存済みゲームがありますが、現在のゲームIDが見つかりません。");
            }
        }
        return prepareGame(null);
    }

    function resetGame(gameId) {
        requireWriter(true);
        if (currentGame(gameId).phase !== "finished") throw new Error("ゲーム終了後にリセットできます。");
        return prepareGame(gameId);
    }

    function writeGame(game) {
        requireWriter(true);
        const previous = currentGame(game.gameId);
        if (previous.revision !== game.revision || previous.phase === "finished") {
            throw new Error("進行情報が更新されました。最新の状態を確認してください。");
        }
        validateGame(game);
        const next = { ...game, revision: game.revision + 1 };
        save(gamePrefix(game.gameId) + "progress", next);
        game.revision = next.revision;
        return game;
    }

    function issueCard(game) {
        requireWriter(true);
        const current = currentGame(game.gameId);
        if (current.phase !== "prepare" || current.revision !== game.revision) {
            throw new Error("カードを発行できません。最新の受付状態を確認してください。");
        }
        let sequence = current.issuedIds.length + 1;
        let cardId;
        let key;
        do {
            cardId = "CARD-" + String(sequence).padStart(3, "0");
            key = cardKey("card", game.gameId, cardId);
            sequence++;
            // 前回のタブが発行票を書いた直後に閉じても、残った保存先を上書きしない。
        } while (current.issuedIds.includes(cardId) || read(key) !== null);
        // 先に発行票を作り、発行済み名簿の保存まで成功してからURLを渡す。
        save(key, { gameId: game.gameId, cardId, cardRows: null, registered: false, displayName: "" });
        try {
            writeGame({ ...current, issuedIds: [...current.issuedIds, cardId] });
        } catch (error) {
            localStorage.removeItem(key);
            throw error;
        }
        return cardId;
    }

    function readCard(gameId, cardId) {
        const card = read(cardKey("card", gameId, cardId));
        if (!card) return null;
        if (card.gameId !== gameId || card.cardId !== cardId || typeof card.registered !== "boolean"
            || typeof card.displayName !== "string" || (card.registered && !card.cardRows)) {
            throw new Error("カードの登録情報が壊れています。");
        }
        if (card.cardRows !== null) validateCard(card.cardRows);
        return card;
    }

    function writeCard(card) {
        requireWriter();
        const game = currentGame(card.gameId);
        if (game.phase !== "prepare" || !game.issuedIds.includes(card.cardId)) {
            throw new Error("このカードの参加受付は終了しています。");
        }
        const saved = readCard(card.gameId, card.cardId);
        if (!saved) throw new Error("カードの発行票が見つかりません。");
        validateCard(card.cardRows);
        if (saved.registered || (saved.cardRows !== null && JSON.stringify(saved.cardRows) !== JSON.stringify(card.cardRows))) {
            throw new Error("確定したカードの名前や配置は変更できません。");
        }
        if (typeof card.registered !== "boolean" || typeof card.displayName !== "string"
            || (card.registered && !card.displayName.trim())) throw new Error("カードの登録情報が正しくありません。");
        save(cardKey("card", card.gameId, card.cardId), card);
    }

    function validateReport(report, gameId, cardId) {
        const round = report.checkedDrawCount;
        const first = report.firstBingoAt;
        const validResult = report.hasBingo === true ? Number.isInteger(first) && first > 0 && first <= round
            : report.hasBingo === false && first === null;
        if (report.gameId !== gameId || report.cardId !== cardId || !Number.isInteger(round)
            || round < 0 || round > BINGO_BALL_COUNT || !validResult) {
            throw new Error("カードの確認報告が壊れています。");
        }
    }

    function readReport(gameId, cardId) {
        const report = read(cardKey("report", gameId, cardId));
        if (report) validateReport(report, gameId, cardId);
        return report;
    }

    function writeReport(report) {
        requireWriter();
        const { gameId, cardId } = report;
        const game = currentGame(gameId);
        validateReport(report, gameId, cardId);
        if (!["playing", "final"].includes(game.phase) || report.checkedDrawCount !== game.history.length
            || !game.participants.some(card => card.cardId === cardId)) {
            throw new Error("受付中のゲーム・参加カード・最新の抽選回を確認してください。");
        }
        const previous = readReport(gameId, cardId);
        if (previous && previous.checkedDrawCount >= report.checkedDrawCount) {
            if (previous.checkedDrawCount === report.checkedDrawCount && previous.hasBingo === report.hasBingo
                && previous.firstBingoAt === report.firstBingoAt) return;
            throw new Error("保存済みの確認報告と一致しません。");
        }
        // 確認回数と当選結果を同じ1レコードにする。別カードの報告は独立したキーに残る。
        save(cardKey("report", gameId, cardId), report);
    }

    function subscribe(callback) {
        function onChange(event) {
            if (event.storageArea !== localStorage) return;
            if (event.key === null || event.key === pointerKey) {
                callback({ type: event.key === null ? "clear" : "game", gameId: null, cardId: null });
                return;
            }
            const start = prefix + "game:";
            if (!event.key.startsWith(start)) return;
            const [gameId, kind, cardId] = event.key.slice(start.length).split(":");
            const type = kind === "progress" ? "game" : kind;
            if (["card", "report", "game"].includes(type)) callback({ type, gameId, cardId: cardId || null });
        }
        window.addEventListener("storage", onChange);
        return () => window.removeEventListener("storage", onChange);
    }

    function cardUrl(gameId, cardId) {
        const url = new URL("card.html", location.href);
        url.search = new URLSearchParams({ gameId, cardId });
        return url.href;
    }

    return {
        withWrite, holdHost, hasHost: () => hostLease !== null,
        readGame, initialGame, writeGame, resetGame, issueCard, cardUrl,
        readCard, writeCard, readReport, writeReport, subscribe,
    };
})();
