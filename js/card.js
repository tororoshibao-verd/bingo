// 参加者のタブ。URLで自分のカードを特定し、保存済みの配置と抽選履歴から画面を作る。
(() => {
    const params = new URLSearchParams(location.search);
    const gameId = params.get("gameId");
    const cardId = params.get("cardId");
    const byId = (id) => document.getElementById(id);
    const board = byId("card-grid").tBodies[0];
    const nameInput = byId("entry-name");
    const entryFeedback = byId("entry-feedback");
    let displayedLayout = "";

    // 絵文字や結合文字も、参加者に見える一文字として数える。
    const segmenter = typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter("ja", { granularity: "grapheme" }) : null;

    // 1. 登録確定では、同じ排他区間で読み直した配置に名前を付ける。
    // 失敗時は入力を残す。先に別タブで登録された場合、この処理には入らない。
    function register(card, input) {
        const name = input.trim();
        const characters = segmenter ? segmenter.segment(name) : name;
        if (Array.from(characters).length > 10) {
            return { view: "register", feedback: "表示名は10文字以内で入力してください。", invalid: true };
        }
        const registered = { ...card, displayName: name || cardId, registered: true };
        try {
            BingoStore.writeCard(registered);
        } catch (error) {
            return { view: "register", feedback: error.message };
        }
        return { view: "playing", card: registered };
    }

    // 2. 毎回、確認した抽選回数とビンゴ判定を一組で本人専用のキーに保存する。
    // 同じURLを別タブで開いている場合は、保存済みの同じ報告を利用できる。
    function reportRound(card, history) {
        const report = createCardReport(card, history);
        const previous = BingoStore.readReport(gameId, cardId);
        if (previous) {
            if (previous.checkedDrawCount > report.checkedDrawCount) {
                throw new Error("カードの確認報告が抽選履歴より先に進んでいます。");
            }
            if (previous.checkedDrawCount === report.checkedDrawCount) {
                if (previous.hasBingo !== report.hasBingo || previous.firstBingoAt !== report.firstBingoAt) {
                    throw new Error("保存済みの確認報告がカードの判定結果と一致しません。");
                }
                return;
            }
        }
        BingoStore.writeReport(report);
    }

    // 3. 発行、登録、開始、リセットがぶつかっても判断がずれないように、呼び出し側で短い鍵を取る。
    // 配置を生成できるのは、準備中の「配置がまだない発行票」を最初に開いた一度だけ。
    function loadCard(input) {
        const game = BingoStore.readGame();
        if (!game) throw new Error("ゲームが見つかりません。進行役から発行されたURLを開いてください。");
        if (game.gameId !== gameId) return { view: "reset" };
        if (!game.issuedIds.includes(cardId)) throw new Error("このゲームで発行されたカードのURLを開いてください。");

        let card = BingoStore.readCard(gameId, cardId);
        if (!card) throw new Error("発行済みカードの保存情報が見つかりません。");
        if (game.phase === "prepare") {
            if (card.cardRows === null) {
                card = { ...card, cardRows: createCard() };
                BingoStore.writeCard(card);
            }
            if (!card.registered) {
                if (input === undefined) return { view: "register" };
                const result = register(card, input);
                return { ...result, game };
            }
        } else {
            // 締切時点の名簿・配置・表示名と照合する。開始後に未登録枠を復活させない。
            const participant = game.participants.find((entry) => entry.cardId === cardId);
            if (!participant && !card.registered) return { view: "closed" };
            if (!participant || !card.registered || participant.displayName !== card.displayName
                || JSON.stringify(participant.cardRows) !== JSON.stringify(card.cardRows)) {
                throw new Error("カードの保存情報がゲーム開始時の登録内容と一致しません。");
            }
            if (game.phase !== "finished") reportRound(card, game.history);
        }
        return { view: game.phase === "finished" ? "ended" : "playing", game, card };
    }

    // 読み上げ用の通知も実際に値が変わったときだけ更新する。
    function setText(id, value) {
        const element = byId(id);
        if (element.textContent !== value) element.textContent = value;
    }

    // 4. 保存した横5行を同じ順で並べる。二回目以降の抽選は盤面を残し、開いた印だけを更新する。
    function renderBoard(card, history) {
        const openCells = getOpenCells(card.cardRows, history);
        const layout = JSON.stringify(card.cardRows);
        if (layout !== displayedLayout) {
            board.replaceChildren();
            for (const row of card.cardRows) {
                const tr = board.insertRow();
                for (const value of row) {
                    const cell = tr.insertCell();
                    if (value === BINGO_FREE) {
                        cell.className = "free-cell";
                        const heart = document.createElement("img");
                        heart.src = "images/heart.svg";
                        heart.width = 24;
                        heart.height = 20;
                        heart.alt = "";
                        cell.append(heart);
                    } else {
                        cell.dataset.number = value;
                    }
                    cell.append(String(value));
                    const description = document.createElement("span");
                    description.className = "sr-only";
                    if (value === BINGO_FREE) description.textContent = " 最初から開いています";
                    cell.append(description);
                }
            }
            displayedLayout = layout;
        }

        for (const row of board.rows) {
            for (const cell of row.cells) {
                if (!cell.hasAttribute("data-number")) continue;
                const opened = openCells[row.sectionRowIndex][cell.cellIndex];
                if (cell.classList.contains("is-open") === opened) continue;
                cell.classList.toggle("is-open", opened);
                cell.lastElementChild.textContent = opened ? " 抽選済み" : "";
            }
        }
    }

    // 5. 進行役が保存した履歴と、自分について確定した結果だけを反映する。
    function renderTicket(card, game) {
        renderBoard(card, game.history);
        setText("card-id", cardId);
        setText("card-name", card.displayName);
        const round = game.history.length;
        const latest = game.history.at(-1);
        setText("card-round", round ? `第${round}回の抽選` : "抽選待ち");
        setText("card-number", latest ? String(latest) : "―");
        setText("card-letter", latest ? "BINGO"[Math.floor((latest - 1) / 15)] : "");
        byId("card-letter").hidden = !latest;
        const badges = { prepare: "開始待ち", playing: "ゲーム中", final: "最終確認中" };
        if (game.phase in badges) document.querySelector(".card-badge.state-playing").textContent = badges[game.phase];
        setText("card-sync", game.phase === "prepare" ? "参加登録が完了しました" : `第${round}回まで反映済み`);

        const win = game.winners.find((group) => group.cards.some((entry) =>
            entry.gameId === gameId && entry.cardId === cardId));
        setText("card-result", win ? `第${win.firstBingoAt}回でビンゴ！ 当選が確定しました。` : "");
        byId("card-result").hidden = !win;
    }

    function showFeedback(message = "", invalid = false) {
        setText("entry-feedback", message);
        entryFeedback.hidden = !message;
        nameInput.setAttribute("aria-invalid", String(invalid));
    }

    function render(state) {
        document.body.dataset.cardState = state.view;
        if (state.view === "register") {
            setText("entry-id", cardId);
            setText("fallback-id", cardId);
            if (state.feedback) showFeedback(state.feedback, state.invalid);
            return;
        }

        nameInput.value = "";
        showFeedback();
        setText("entry-id", "");
        setText("fallback-id", "");
        if (state.view === "playing" || state.view === "ended") {
            renderTicket(state.card, state.game);
            return;
        }
        // リセット・締切・エラーの画面に、前のカードのIDや数字、当選メッセージを持ち越さない。
        displayedLayout = "";
        board.replaceChildren();
        for (const id of ["card-id", "card-name", "card-letter", "card-number", "card-round", "card-result", "card-sync"]) {
            setText(id, "");
        }
        byId("card-result").hidden = true;
        if (state.view === "error") setText("card-error-reason", state.reason);
    }

    async function update(input) {
        try {
            if (!gameId || !cardId) throw new Error("進行役から発行されたカードのURLを開いてください。");
            const state = await BingoStore.withWrite(() => loadCard(input));
            render(state);
        } catch (error) {
            render({ view: "error", reason: error.message });
        }
    }

    // 6. 他タブの変更は「最新状態を読む合図」。連続した通知をまとめ、復帰時にも履歴の先頭から追いつく。
    let refreshing = false;
    let refreshRequested = false;
    async function refresh() {
        refreshRequested = true;
        if (refreshing) return;
        refreshing = true;
        try {
            while (refreshRequested) {
                refreshRequested = false;
                await update();
            }
        } finally {
            refreshing = false;
        }
    }

    byId("entry-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = byId("register-card");
        if (button.disabled) return;
        button.disabled = true;
        try {
            await update(nameInput.value);
        } finally {
            button.disabled = false;
        }
    });
    nameInput.addEventListener("input", () => showFeedback());
    byId("retry-card").addEventListener("click", refresh);
    BingoStore.subscribe((change) => {
        if (change.type === "clear" || (change.type === "game" && (!change.gameId || change.gameId === gameId))
            || (change.type === "card" && change.gameId === gameId && change.cardId === cardId)) {
            refresh();
        }
    });
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) refresh();
    });
    refresh();
})();
