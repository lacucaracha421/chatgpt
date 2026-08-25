(() => {
  "use strict";

  const TWEET_SELECTOR = 'article[data-testid="tweet"]';
  const PHOTO_SELECTOR = '[data-testid="tweetPhoto"] img';
  const GALLERY_ROOT_ID = "lakomics-x-recommendation-gallery";
  const HOME_PATHS = new Set(["/", "/home"]);
  const AUTO_TARGET_NEW_IMAGES = 100;
  const AUTO_STEP_VIEWPORT_RATIO = 0.88;
  const AUTO_MIN_STEP_PX = 560;
  const AUTO_SETTLE_MS = 380;
  const AUTO_PROGRESS_TIMEOUT_MS = 2800;
  const AUTO_MAX_NO_PROGRESS_ROUNDS = 8;
  const AUTO_MAX_RUNTIME_MS = 120_000;
  const SAVED_STORAGE_KEY = "lakomicsXGallerySavedMediaV1";
  const SAVED_MAX_ITEMS = 3000;
  const SAVED_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  const GALLERY_INITIAL_RENDER_ITEMS = 36;
  const GALLERY_RENDER_BATCH_ITEMS = 24;
  const GALLERY_LOAD_MORE_THRESHOLD_PX = 900;
  const LIKE_FILTER_THRESHOLDS = [0, 1000, 5000, 10000];

  function parseStatusHref(value) {
    let url;
    try {
      url = new URL(value, globalThis.location?.href ?? "https://x.com/");
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || !["x.com", "twitter.com"].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)(?:\/photo\/(\d+))?/);
    if (!match) return null;
    return {
      username: match[1],
      tweetId: match[2],
      photoIndex: match[3] ? Number.parseInt(match[3], 10) - 1 : null,
      postUrl: `https://x.com/${match[1]}/status/${match[2]}`,
    };
  }

  function selectedTabIsFirst(tabs) {
    const items = Array.from(tabs ?? []);
    if (items.length < 2) return false;
    const selectedIndex = items.findIndex((tab) => tab.getAttribute?.("aria-selected") === "true");
    return selectedIndex === 0;
  }

  function isHomeRoute(pathname = globalThis.location?.pathname ?? "") {
    return HOME_PATHS.has(pathname);
  }

  function isForYouTimeline(root = document) {
    if (!isHomeRoute()) return false;
    const primary = root.querySelector?.('[data-testid="primaryColumn"]') ?? root;
    const tablists = primary.querySelectorAll?.('[role="tablist"]') ?? [];
    for (const tablist of tablists) {
      const tabs = tablist.querySelectorAll?.('[role="tab"]') ?? [];
      if (selectedTabIsFirst(tabs)) return true;
    }
    return false;
  }

  function findTweetIdentity(article) {
    const time = article?.querySelector?.("time");
    const timedLink = time?.closest?.('a[href*="/status/"]');
    const timed = parseStatusHref(timedLink?.getAttribute?.("href") || timedLink?.href || "");
    if (timed) return timed;

    const links = article?.querySelectorAll?.('a[href*="/status/"]') ?? [];
    for (const link of links) {
      const parsed = parseStatusHref(link.getAttribute?.("href") || link.href || "");
      if (parsed && parsed.photoIndex === null) return parsed;
    }
    for (const link of links) {
      const parsed = parseStatusHref(link.getAttribute?.("href") || link.href || "");
      if (parsed) return parsed;
    }
    return null;
  }

  function mediaBelongsToTweet(image, tweetId) {
    const direct = image?.closest?.('a[href*="/status/"]');
    const directStatus = parseStatusHref(direct?.getAttribute?.("href") || direct?.href || "");
    if (directStatus && directStatus.tweetId !== tweetId) return false;

    const roleLink = image?.closest?.('[role="link"]');
    const nestedLinks = roleLink?.querySelectorAll?.('a[href*="/status/"]') ?? [];
    for (const link of nestedLinks) {
      const parsed = parseStatusHref(link.getAttribute?.("href") || link.href || "");
      if (parsed && parsed.tweetId !== tweetId) return false;
    }
    return true;
  }

  function parseCompactMetric(value) {
    const text = String(value ?? "").replace(/\u00a0/g, " ").trim();
    if (!text) return null;
    const match = text.match(/(?:^|[^0-9])([0-9][0-9.,]*)(?:\s*)(K|M|B|T|천|만|억|万|億)?/i);
    if (!match) return null;

    const suffix = match[2] || "";
    let numberText = match[1];
    if (suffix) {
      const commaCount = (numberText.match(/,/g) || []).length;
      const dotCount = (numberText.match(/\./g) || []).length;
      if (commaCount && dotCount) {
        const lastComma = numberText.lastIndexOf(",");
        const lastDot = numberText.lastIndexOf(".");
        const decimal = lastComma > lastDot ? "," : ".";
        const thousands = decimal === "," ? "." : ",";
        numberText = numberText.split(thousands).join("").replace(decimal, ".");
      } else if (commaCount === 1 && /,[0-9]{1,2}$/.test(numberText)) {
        numberText = numberText.replace(",", ".");
      } else {
        numberText = numberText.replace(/,/g, "");
      }
    } else {
      numberText = numberText.replace(/[.,]/g, "");
    }

    const number = Number.parseFloat(numberText);
    if (!Number.isFinite(number)) return null;
    const multipliers = {
      K: 1_000, M: 1_000_000, B: 1_000_000_000, T: 1_000_000_000_000,
      "천": 1_000, "만": 10_000, "억": 100_000_000,
      "万": 10_000, "億": 100_000_000,
    };
    const multiplier = suffix ? (multipliers[suffix.toUpperCase?.() ?? suffix] ?? multipliers[suffix] ?? 1) : 1;
    return Math.max(0, Math.round(number * multiplier));
  }

  function extractLikeCount(article) {
    const likeButton = article?.querySelector?.('[data-testid="like"], [data-testid="unlike"]');
    if (!likeButton) return null;
    const candidates = [
      likeButton.getAttribute?.("aria-label"),
      likeButton.innerText,
      likeButton.textContent,
    ];
    for (const candidate of candidates) {
      const parsed = parseCompactMetric(candidate);
      if (parsed !== null) return parsed;
    }
    return 0;
  }

  function matchesLikeFilter(item, minLikes = 0) {
    const threshold = Math.max(0, Number(minLikes) || 0);
    if (!threshold) return true;
    const count = Number(item?.likeCount);
    return Number.isFinite(count) && count >= threshold;
  }

  function formatLikeCount(value) {
    if (value === null || value === undefined || value === "") return "—";
    const count = Number(value);
    if (!Number.isFinite(count) || count < 0) return "—";
    try {
      return new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 }).format(count);
    } catch {
      if (count >= 10_000) return `${Math.round(count / 1000) / 10}만`;
      if (count >= 1_000) return `${Math.round(count / 100) / 10}천`;
      return String(Math.round(count));
    }
  }

  function extractPost(article, collectedAt = Date.now()) {
    const identity = findTweetIdentity(article);
    if (!identity) return null;
    const normalizer = globalThis.LakomicsXSource?.normalizeMediaUrl;
    if (typeof normalizer !== "function") return null;

    const images = [];
    const seen = new Set();
    const photoImages = article?.querySelectorAll?.(PHOTO_SELECTOR) ?? [];
    for (const image of photoImages) {
      if (!mediaBelongsToTweet(image, identity.tweetId)) continue;
      const source = image.currentSrc || image.src || image.getAttribute?.("src") || "";
      const mediaUrl = normalizer(source);
      if (!mediaUrl || seen.has(mediaUrl)) continue;
      seen.add(mediaUrl);
      images.push({
        url: mediaUrl,
        index: images.length + 1,
      });
    }
    if (!images.length) return null;

    return {
      tweetId: identity.tweetId,
      username: identity.username,
      author: `@${identity.username}`,
      postUrl: identity.postUrl,
      images,
      likeCount: extractLikeCount(article),
      collectedAt,
    };
  }

  function flattenPostImages(post, images = post?.images ?? []) {
    return images.map((image) => ({
      tweetId: post.tweetId,
      username: post.username,
      author: post.author,
      postUrl: post.postUrl,
      collectedAt: post.collectedAt,
      imageIndex: image.index,
      imageUrl: image.url,
      likeCount: post.likeCount,
    }));
  }

  function galleryItemKey(item) {
    if (!item) return "";
    const tweetId = String(item.tweetId ?? "");
    const imageIndex = String(item.imageIndex ?? "");
    const imageUrl = String(item.imageUrl ?? "");
    return imageUrl ? `${tweetId}:${imageIndex}:${imageUrl}` : `${tweetId}:${imageIndex}`;
  }

  function takeUnrenderedGalleryItems(items, renderedKeys, limit) {
    const result = [];
    const maxItems = Math.max(0, Number(limit) || 0);
    if (!maxItems) return result;
    for (const item of items ?? []) {
      const key = galleryItemKey(item);
      if (!key || renderedKeys?.has?.(key)) continue;
      result.push(item);
      if (result.length >= maxItems) break;
    }
    return result;
  }

  function createGalleryStore(onChange = () => {}) {
    const posts = new Map();

    function upsert(post) {
      if (!post?.tweetId || !Array.isArray(post.images) || !post.images.length) return false;
      const existing = posts.get(post.tweetId);
      if (!existing) {
        const stored = {
          ...post,
          images: post.images.map((image) => ({ ...image })),
        };
        posts.set(post.tweetId, stored);
        onChange({ type: "upsert", items: flattenPostImages(stored) });
        return true;
      }

      const known = new Set(existing.images.map((image) => image.url));
      const additions = post.images.filter((image) => image?.url && !known.has(image.url));
      const incomingLikes = Number(post.likeCount);
      const existingLikes = Number(existing.likeCount);
      const likeCountImproved = Number.isFinite(incomingLikes)
        && (!Number.isFinite(existingLikes) || incomingLikes > existingLikes);
      if (likeCountImproved) existing.likeCount = incomingLikes;
      if (!additions.length && !likeCountImproved) return false;
      const storedAdditions = additions.map((image) => ({ ...image }));
      if (storedAdditions.length) {
        existing.images.push(...storedAdditions);
        existing.collectedAt = Math.min(existing.collectedAt ?? post.collectedAt, post.collectedAt);
      }
      onChange({
        type: likeCountImproved ? "metadata" : "upsert",
        items: likeCountImproved ? flattenPostImages(existing) : flattenPostImages(existing, storedAdditions),
      });
      return true;
    }

    function flatImages() {
      return Array.from(posts.values())
        .sort((a, b) => (b.collectedAt ?? 0) - (a.collectedAt ?? 0))
        .flatMap((post) => flattenPostImages(post));
    }

    function imageCount(minLikes = 0) {
      let count = 0;
      for (const post of posts.values()) {
        if (matchesLikeFilter(post, minLikes)) count += post.images.length;
      }
      return count;
    }

    function postCount(minLikes = 0) {
      let count = 0;
      for (const post of posts.values()) {
        if (matchesLikeFilter(post, minLikes)) count += 1;
      }
      return count;
    }

    function clear() {
      if (!posts.size) return false;
      posts.clear();
      onChange({ type: "clear", items: [] });
      return true;
    }

    return { upsert, flatImages, imageCount, postCount, clear };
  }

  function nextAutoHarvestState({ currentCount, targetCount, noProgressRounds, elapsedMs, stillForYou, moved }) {
    if (!stillForYou) return { done: true, reason: "추천 탭을 벗어나 자동 수집을 중지했습니다" };
    if (currentCount >= targetCount) return { done: true, reason: "목표 수집 완료" };
    if (elapsedMs >= AUTO_MAX_RUNTIME_MS) return { done: true, reason: "자동 수집 시간 제한에 도달했습니다" };
    if (!moved && noProgressRounds >= 2) return { done: true, reason: "추천 피드의 끝에 도달했습니다" };
    if (noProgressRounds >= AUTO_MAX_NO_PROGRESS_ROUNDS) return { done: true, reason: "새 추천 이미지를 더 찾지 못했습니다" };
    return { done: false, reason: "" };
  }

  function pruneSavedEntries(value, now = Date.now()) {
    const entries = Object.entries(value && typeof value === "object" ? value : {})
      .filter(([url, timestamp]) => typeof url === "string" && Number.isFinite(Number(timestamp))
        && now - Number(timestamp) <= SAVED_MAX_AGE_MS)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, SAVED_MAX_ITEMS);
    return Object.fromEntries(entries);
  }

  if (globalThis.__LAKOMICS_TEST__) {
    globalThis.LakomicsXGallery = {
      AUTO_TARGET_NEW_IMAGES,
      GALLERY_INITIAL_RENDER_ITEMS,
      GALLERY_RENDER_BATCH_ITEMS,
      LIKE_FILTER_THRESHOLDS,
      createGalleryStore,
      galleryItemKey,
      extractLikeCount,
      extractPost,
      formatLikeCount,
      findTweetIdentity,
      isHomeRoute,
      mediaBelongsToTweet,
      matchesLikeFilter,
      nextAutoHarvestState,
      parseCompactMetric,
      parseStatusHref,
      pruneSavedEntries,
      selectedTabIsFirst,
      takeUnrenderedGalleryItems,
    };
    return;
  }

  installGallery();

  function installGallery() {
    if (document.getElementById(GALLERY_ROOT_ID)) return;

    let overlayOpen = false;
    let articleFlushQueued = false;
    let lastPathname = location.pathname;
    let routeSyncQueued = false;
    let harvest = null;
    let harvestLoopToken = 0;
    let storeVersion = 0;
    let timelineVersion = 0;
    let galleryRenderQueued = false;
    let galleryLoadMoreQueued = false;
    let minLikeFilter = 0;
    const observedArticles = new WeakSet();
    const visibleArticles = new WeakSet();
    const pendingArticles = new Set();
    const pendingGalleryItems = new Map();
    const renderedGalleryKeys = new Set();
    const savedMedia = new Map();

    const ui = createGalleryUi();
    globalThis.LakomicsXGalleryRuntime = { markSaved };
    const store = createGalleryStore((change) => {
      storeVersion += 1;
      if (change?.type === "clear") {
        resetGalleryRender();
      } else {
        for (const item of change?.items ?? []) {
          const key = galleryItemKey(item);
          if (!key) continue;
          if (renderedGalleryKeys.has(key)) updateRenderedCardMetadata(item);
          else pendingGalleryItems.set(key, item);
        }
      }
      updateCounters();
      if (overlayOpen && !harvest?.running) queueGalleryRender();
    });
    void loadSavedMedia();

    const intersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio > 0) {
          visibleArticles.add(entry.target);
          queueArticle(entry.target);
        } else {
          visibleArticles.delete(entry.target);
        }
      }
    }, { threshold: [0, 0.08] });

    const mutationObserver = new MutationObserver((mutations) => {
      let routeMayHaveChanged = false;
      for (const mutation of mutations) {
        if (ui.root.contains(mutation.target)) continue;
        routeMayHaveChanged = true;
        let timelineTouched = false;
        const ownerArticle = mutation.target?.closest?.(TWEET_SELECTOR);
        if (ownerArticle) {
          timelineTouched = true;
          observeArticle(ownerArticle);
          if (visibleArticles.has(ownerArticle)) queueArticle(ownerArticle);
        }
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches?.(TWEET_SELECTOR)) {
            timelineTouched = true;
            observeArticle(node);
          }
          const nested = node.querySelectorAll?.(TWEET_SELECTOR) ?? [];
          if (nested.length) timelineTouched = true;
          for (const article of nested) observeArticle(article);
        }
        if (timelineTouched) timelineVersion += 1;
      }
      if (routeMayHaveChanged) queueRouteSync();
    });

    mutationObserver.observe(document.body, { childList: true, subtree: true });
    for (const article of document.querySelectorAll(TWEET_SELECTOR)) observeArticle(article);
    syncRouteState();
    updateCounters();

    window.addEventListener("popstate", syncRouteState);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && overlayOpen) closeGallery();
    }, true);

    ui.trigger.addEventListener("click", () => overlayOpen ? closeGallery() : openGallery());
    ui.close.addEventListener("click", closeGallery);
    ui.clear.addEventListener("click", () => {
      if (harvest?.running) stopAutoHarvest("자동 수집을 중지했습니다", true);
      store.clear();
    });
    ui.auto.addEventListener("click", () => {
      if (harvest?.running) stopAutoHarvest("자동 수집을 중지했습니다", true);
      else startAutoHarvest();
    });
    ui.overlay.addEventListener("click", (event) => {
      if (event.target === ui.overlay) closeGallery();
    });
    ui.scroll.addEventListener("scroll", queueGalleryLoadMore, { passive: true });
    ui.likeFilter.addEventListener("change", () => {
      const next = Number(ui.likeFilter.value);
      minLikeFilter = LIKE_FILTER_THRESHOLDS.includes(next) ? next : 0;
      resetGalleryRender();
      renderInitialGallery();
      updateCounters();
    });

    function observeArticle(article) {
      if (!article || observedArticles.has(article)) return;
      observedArticles.add(article);
      intersectionObserver.observe(article);
      if (isElementVisible(article)) {
        visibleArticles.add(article);
        queueArticle(article);
      }
    }

    function queueArticle(article) {
      if (!article) return;
      pendingArticles.add(article);
      if (articleFlushQueued) return;
      articleFlushQueued = true;
      requestAnimationFrame(flushArticles);
    }

    function flushArticles() {
      articleFlushQueued = false;
      if (!isForYouTimeline(document)) {
        pendingArticles.clear();
        return;
      }
      const now = Date.now();
      for (const article of pendingArticles) {
        if (!article.isConnected || !visibleArticles.has(article)) continue;
        const post = extractPost(article, now);
        if (post) store.upsert(post);
      }
      pendingArticles.clear();
    }

    function queueRouteSync() {
      if (routeSyncQueued) return;
      routeSyncQueued = true;
      requestAnimationFrame(() => {
        routeSyncQueued = false;
        syncRouteState();
      });
    }

    function syncRouteState() {
      const pathname = location.pathname;
      const routeChanged = pathname !== lastPathname;
      lastPathname = pathname;
      ui.trigger.hidden = !isHomeRoute(pathname);
      if (!isHomeRoute(pathname) && overlayOpen) closeGallery();
      if (harvest?.running && !isForYouTimeline(document)) {
        stopAutoHarvest("추천 탭을 벗어나 자동 수집을 중지했습니다", true);
      }
      if (routeChanged && isHomeRoute(pathname)) {
        for (const article of document.querySelectorAll(TWEET_SELECTOR)) observeArticle(article);
      }
      updateCounters();
    }

    function openGallery() {
      overlayOpen = true;
      ui.overlay.hidden = false;
      ui.trigger.setAttribute("aria-expanded", "true");
      resetGalleryRender();
      renderInitialGallery();
      ui.close.focus({ preventScroll: true });
    }

    function closeGallery() {
      overlayOpen = false;
      if (harvest?.running) stopAutoHarvest("자동 수집을 중지했습니다", true);
      ui.overlay.hidden = true;
      ui.trigger.setAttribute("aria-expanded", "false");
      ui.trigger.focus({ preventScroll: true });
    }

    function queueGalleryRender() {
      if (galleryRenderQueued || !overlayOpen || harvest?.running) return;
      galleryRenderQueued = true;
      requestAnimationFrame(() => {
        galleryRenderQueued = false;
        if (!overlayOpen || harvest?.running) return;
        const items = Array.from(pendingGalleryItems.values()).filter((item) => matchesLikeFilter(item, minLikeFilter));
        pendingGalleryItems.clear();
        insertGalleryItemsSorted(items);
      });
    }

    function queueGalleryLoadMore() {
      if (galleryLoadMoreQueued || !overlayOpen) return;
      const remaining = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight;
      if (remaining > GALLERY_LOAD_MORE_THRESHOLD_PX) return;
      galleryLoadMoreQueued = true;
      requestAnimationFrame(() => {
        galleryLoadMoreQueued = false;
        if (overlayOpen) renderNextGalleryBatch();
      });
    }

    function updateCounters() {
      const imageCount = store.imageCount();
      const filteredImageCount = store.imageCount(minLikeFilter);
      const filteredPostCount = store.postCount(minLikeFilter);
      ui.triggerCount.textContent = String(imageCount);
      ui.summary.textContent = minLikeFilter
        ? `${filteredImageCount}/${imageCount} images · ${filteredPostCount} posts · ♥ ${formatLikeCount(minLikeFilter)}+`
        : `${imageCount} images · ${store.postCount()} posts`;
      ui.trigger.classList.toggle("is-empty", imageCount === 0);
      ui.trigger.title = isForYouTimeline(document)
        ? `추천 이미지 ${imageCount}개 — 추천 피드를 보며 수집 중`
        : `추천 이미지 ${imageCount}개 — 팔로잉 탭에서는 수집 일시정지`;
      updateHarvestUi();
    }

    function updateHarvestUi(message = "") {
      const running = Boolean(harvest?.running);
      ui.auto.classList.toggle("is-running", running);
      ui.auto.textContent = running ? "■ 중지" : "▶ 자동 수집";
      if (running) {
        const added = Math.max(0, store.imageCount() - harvest.startImageCount);
        ui.harvestStatus.textContent = `자동 수집 중 · +${added}/${AUTO_TARGET_NEW_IMAGES}`;
        ui.harvestStatus.hidden = false;
      } else if (message) {
        ui.harvestStatus.textContent = message;
        ui.harvestStatus.hidden = false;
      } else {
        ui.harvestStatus.hidden = true;
        ui.harvestStatus.textContent = "";
      }
    }

    function resetGalleryRender() {
      renderedGalleryKeys.clear();
      pendingGalleryItems.clear();
      ui.grid.replaceChildren();
      ui.empty.hidden = store.imageCount(minLikeFilter) > 0;
      ui.scroll.scrollTop = 0;
    }

    function renderInitialGallery() {
      const items = store.flatImages().filter((item) => matchesLikeFilter(item, minLikeFilter));
      ui.empty.hidden = items.length > 0;
      if (!items.length) return;
      pendingGalleryItems.clear();
      appendGalleryItems(takeUnrenderedGalleryItems(items, renderedGalleryKeys, GALLERY_INITIAL_RENDER_ITEMS));
    }

    function renderNextGalleryBatch() {
      const items = store.flatImages().filter((item) => matchesLikeFilter(item, minLikeFilter));
      const batch = takeUnrenderedGalleryItems(items, renderedGalleryKeys, GALLERY_RENDER_BATCH_ITEMS);
      appendGalleryItems(batch);
    }

    function appendGalleryItems(items) {
      const fresh = (items ?? []).filter((item) => {
        const key = galleryItemKey(item);
        return key && !renderedGalleryKeys.has(key);
      });
      if (!fresh.length) return;
      const fragment = document.createDocumentFragment();
      for (const item of fresh) {
        const key = galleryItemKey(item);
        renderedGalleryKeys.add(key);
        fragment.append(createCard(item));
      }
      ui.grid.append(fragment);
      ui.empty.hidden = true;
      queueGalleryLoadMore();
    }

    function insertGalleryItemsSorted(items) {
      const fresh = (items ?? []).filter((item) => {
        const key = galleryItemKey(item);
        return key && !renderedGalleryKeys.has(key) && matchesLikeFilter(item, minLikeFilter);
      });
      if (!fresh.length) return;
      fresh.sort((a, b) => {
        const timeDelta = Number(b.collectedAt || 0) - Number(a.collectedAt || 0);
        if (timeDelta) return timeDelta;
        if (a.tweetId === b.tweetId) return Number(a.imageIndex || 0) - Number(b.imageIndex || 0);
        return String(b.tweetId || "").localeCompare(String(a.tweetId || ""));
      });
      for (const item of fresh) {
        const key = galleryItemKey(item);
        const card = createCard(item);
        const collectedAt = Number(item.collectedAt || 0);
        const imageIndex = Number(item.imageIndex || 0);
        let before = null;
        for (const child of ui.grid.children) {
          const childCollectedAt = Number(child.getAttribute("data-lakomics-collected-at") || 0);
          if (collectedAt > childCollectedAt) {
            before = child;
            break;
          }
          if (collectedAt === childCollectedAt
            && child.getAttribute("data-lakomics-tweet-id") === String(item.tweetId || "")
            && imageIndex < Number(child.getAttribute("data-lakomics-media-index") || 0)) {
            before = child;
            break;
          }
        }
        renderedGalleryKeys.add(key);
        ui.grid.insertBefore(card, before);
      }
      ui.empty.hidden = true;
      queueGalleryLoadMore();
    }

    function createCard(item) {
      const card = document.createElement("article");
      card.className = "lakomics-x-gallery-card";
      const saved = savedMedia.has(item.imageUrl);
      card.classList.toggle("is-saved", saved);
      card.setAttribute("data-lakomics-media-url", item.imageUrl);
      card.setAttribute("data-lakomics-collected-at", String(Number(item.collectedAt || 0)));
      card.setAttribute("data-lakomics-tweet-id", String(item.tweetId || ""));
      card.setAttribute("data-lakomics-media-index", String(item.imageIndex || 1));
      card.setAttribute("data-lakomics-like-count", Number.isFinite(Number(item.likeCount)) ? String(Number(item.likeCount)) : "");
      card.setAttribute("data-lakomics-gallery-key", galleryItemKey(item));

      const imageLink = document.createElement("a");
      imageLink.className = "lakomics-x-gallery-image-link";
      imageLink.href = item.postUrl;
      imageLink.target = "_blank";
      imageLink.rel = "noopener noreferrer";
      imageLink.title = "원문 열기";

      const image = document.createElement("img");
      image.className = "lakomics-x-gallery-image";
      image.src = item.imageUrl;
      image.loading = "lazy";
      image.decoding = "async";
      image.alt = `${item.author} 이미지`;
      image.setAttribute("data-lakomics-media-url", item.imageUrl);
      image.setAttribute("data-lakomics-source-url", item.postUrl);
      image.setAttribute("data-lakomics-author", item.username || item.author.replace(/^@/, ""));
      image.setAttribute("data-lakomics-post-id", item.tweetId);
      image.setAttribute("data-lakomics-media-index", String(item.imageIndex || 1));
      image.draggable = false;
      imageLink.append(image);

      const savedBadge = document.createElement("span");
      savedBadge.className = "lakomics-x-gallery-saved-badge";
      savedBadge.textContent = "✓ 저장됨";
      savedBadge.setAttribute("aria-label", "이미 저장됨");

      const footer = document.createElement("div");
      footer.className = "lakomics-x-gallery-footer";
      const author = document.createElement("span");
      author.className = "lakomics-x-gallery-author";
      author.textContent = item.author;
      const likes = document.createElement("span");
      likes.className = "lakomics-x-gallery-likes";
      likes.textContent = `♥ ${formatLikeCount(item.likeCount)}`;
      likes.title = Number.isFinite(Number(item.likeCount)) ? `좋아요 ${Number(item.likeCount).toLocaleString()}개` : "좋아요 수를 읽지 못함";
      const hint = document.createElement("span");
      hint.className = "lakomics-x-gallery-hint";
      hint.textContent = "길게 눌러 저장 · 탭 원문";
      footer.append(author, likes, hint);
      card.append(imageLink, savedBadge, footer);
      return card;
    }

    function updateRenderedCardMetadata(item) {
      const key = galleryItemKey(item);
      if (!key) return;
      for (const card of ui.grid.children) {
        if (card.getAttribute("data-lakomics-gallery-key") !== key) continue;
        const count = Number(item.likeCount);
        card.setAttribute("data-lakomics-like-count", Number.isFinite(count) ? String(count) : "");
        const likes = card.querySelector(".lakomics-x-gallery-likes");
        if (likes) {
          likes.textContent = `♥ ${formatLikeCount(item.likeCount)}`;
          likes.title = Number.isFinite(count) ? `좋아요 ${count.toLocaleString()}개` : "좋아요 수를 읽지 못함";
        }
        break;
      }
    }

    async function loadSavedMedia() {
      const stored = await storageGet(SAVED_STORAGE_KEY);
      const pruned = pruneSavedEntries(stored?.[SAVED_STORAGE_KEY]);
      savedMedia.clear();
      for (const [url, timestamp] of Object.entries(pruned)) savedMedia.set(url, Number(timestamp));
      if (overlayOpen) refreshSavedMarkers();
      if (Object.keys(pruned).length !== Object.keys(stored?.[SAVED_STORAGE_KEY] ?? {}).length) {
        void storageSet({ [SAVED_STORAGE_KEY]: pruned });
      }
    }

    function markSaved(mediaUrl) {
      const normalizer = globalThis.LakomicsXSource?.normalizeMediaUrl;
      const normalized = typeof normalizer === "function" ? normalizer(mediaUrl) : mediaUrl;
      if (!normalized) return;
      savedMedia.set(normalized, Date.now());
      const snapshot = pruneSavedEntries(Object.fromEntries(savedMedia));
      savedMedia.clear();
      for (const [url, timestamp] of Object.entries(snapshot)) savedMedia.set(url, Number(timestamp));
      void storageSet({ [SAVED_STORAGE_KEY]: snapshot });
      for (const card of ui.grid.querySelectorAll('.lakomics-x-gallery-card')) {
        if (card.getAttribute('data-lakomics-media-url') === normalized) card.classList.add('is-saved');
      }
    }

    function refreshSavedMarkers() {
      for (const card of ui.grid.querySelectorAll('.lakomics-x-gallery-card')) {
        const mediaUrl = card.getAttribute('data-lakomics-media-url');
        card.classList.toggle('is-saved', savedMedia.has(mediaUrl));
      }
    }

    function startAutoHarvest() {
      if (!isForYouTimeline(document)) {
        updateHarvestUi("추천 탭에서만 자동 수집할 수 있습니다");
        return;
      }
      const scrollTop = getScrollTop();
      harvest = {
        running: true,
        startScrollTop: scrollTop,
        startImageCount: store.imageCount(),
        targetImageCount: store.imageCount() + AUTO_TARGET_NEW_IMAGES,
        startedAt: Date.now(),
        noProgressRounds: 0,
      };
      const token = ++harvestLoopToken;
      updateHarvestUi();
      void runAutoHarvest(token);
    }

    async function runAutoHarvest(token) {
      while (harvest?.running && token === harvestLoopToken) {
        if (!isForYouTimeline(document)) {
          stopAutoHarvest("추천 탭을 벗어나 자동 수집을 중지했습니다", true);
          return;
        }

        const beforeCount = store.imageCount();
        const beforeScroll = getScrollTop();
        const beforeVersion = storeVersion;
        const beforeTimelineVersion = timelineVersion;
        const step = Math.max(AUTO_MIN_STEP_PX, Math.round((globalThis.innerHeight || 800) * AUTO_STEP_VIEWPORT_RATIO));
        globalThis.scrollBy({ top: step, left: 0, behavior: "auto" });

        const progressed = await waitForActivity(beforeVersion, beforeTimelineVersion, AUTO_PROGRESS_TIMEOUT_MS, token);
        if (!harvest?.running || token !== harvestLoopToken) return;
        await delay(AUTO_SETTLE_MS);
        if (!harvest?.running || token !== harvestLoopToken) return;

        const afterCount = store.imageCount();
        const afterScroll = getScrollTop();
        const moved = Math.abs(afterScroll - beforeScroll) > 4;
        if (progressed || afterCount > beforeCount) harvest.noProgressRounds = 0;
        else harvest.noProgressRounds += 1;
        updateHarvestUi();

        const decision = nextAutoHarvestState({
          currentCount: afterCount,
          targetCount: harvest.targetImageCount,
          noProgressRounds: harvest.noProgressRounds,
          elapsedMs: Date.now() - harvest.startedAt,
          stillForYou: isForYouTimeline(document),
          moved,
        });
        if (decision.done) {
          stopAutoHarvest(decision.reason, true);
          return;
        }
      }
    }

    function stopAutoHarvest(reason, restorePosition) {
      const current = harvest;
      if (!current) {
        updateHarvestUi(reason);
        return;
      }
      current.running = false;
      harvestLoopToken += 1;
      harvest = null;
      updateHarvestUi(reason);
      if (overlayOpen) {
        resetGalleryRender();
        renderInitialGallery();
      }
      if (restorePosition && Number.isFinite(current.startScrollTop)) {
        window.setTimeout(() => {
          setScrollTop(current.startScrollTop);
        }, 120);
      }
    }

    function waitForActivity(storeVersionAtStart, timelineVersionAtStart, timeoutMs, token) {
      return new Promise((resolve) => {
        const started = Date.now();
        function poll() {
          if (token !== harvestLoopToken || !harvest?.running) return resolve(false);
          if (storeVersion !== storeVersionAtStart || timelineVersion !== timelineVersionAtStart) return resolve(true);
          if (Date.now() - started >= timeoutMs) return resolve(false);
          window.setTimeout(poll, 80);
        }
        poll();
      });
    }
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        const maybe = chrome.storage.local.get([key], (value) => resolve(value ?? {}));
        if (maybe && typeof maybe.then === "function") maybe.then((value) => resolve(value ?? {})).catch(() => resolve({}));
      } catch {
        resolve({});
      }
    });
  }

  function storageSet(value) {
    return new Promise((resolve) => {
      try {
        const maybe = chrome.storage.local.set(value, () => resolve());
        if (maybe && typeof maybe.then === "function") maybe.then(resolve).catch(resolve);
      } catch {
        resolve();
      }
    });
  }

  function getScrollTop() {
    return globalThis.scrollY
      ?? document.scrollingElement?.scrollTop
      ?? document.documentElement?.scrollTop
      ?? 0;
  }

  function setScrollTop(value) {
    const top = Math.max(0, Number(value) || 0);
    try {
      globalThis.scrollTo({ top, left: 0, behavior: "auto" });
    } catch {
      globalThis.scrollTo(0, top);
    }
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function isElementVisible(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect) return false;
    return rect.bottom > 0 && rect.top < (globalThis.innerHeight || document.documentElement.clientHeight);
  }

  function createGalleryUi() {
    const root = document.createElement("div");
    root.id = GALLERY_ROOT_ID;
    root.innerHTML = `
      <style>
        #${GALLERY_ROOT_ID}, #${GALLERY_ROOT_ID} * { box-sizing: border-box; }
        #${GALLERY_ROOT_ID} { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-trigger { position: fixed; top: 72px; right: 18px; min-width: 52px; height: 38px; padding: 0 12px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; border: 1px solid rgba(127,127,127,.34); border-radius: 999px; background: rgba(18,18,18,.88); color: #f2f2f2; box-shadow: 0 8px 26px rgba(0,0,0,.24); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); cursor: pointer; pointer-events: auto; font: inherit; font-size: 13px; font-weight: 650; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-trigger:hover { background: rgba(34,34,34,.94); }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-trigger.is-empty { opacity: .68; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-trigger[hidden] { display: none !important; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-trigger-icon { font-size: 16px; line-height: 1; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-overlay { position: fixed; inset: 0; display: flex; flex-direction: column; background: rgba(8,8,10,.97); color: #f4f4f5; pointer-events: auto; overscroll-behavior: contain; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-overlay[hidden] { display: none !important; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-header { flex: 0 0 auto; min-height: 62px; padding: 8px 18px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid rgba(255,255,255,.1); background: rgba(12,12,14,.96); }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-title-wrap { min-width: 0; flex: 1; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-title { margin: 0; font-size: 18px; line-height: 1.2; font-weight: 750; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-summary { margin-top: 3px; color: #9ca3af; font-size: 12px; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-harvest-status { margin-top: 2px; color: #7dd3fc; font-size: 11px; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-harvest-status[hidden] { display: none !important; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-header button { min-height: 36px; padding: 0 12px; border: 0; border-radius: 999px; background: transparent; color: #d4d4d8; cursor: pointer; font: inherit; white-space: nowrap; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-header button:hover { background: rgba(255,255,255,.09); color: #fff; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-like-filter { height: 34px; padding: 0 28px 0 10px; border: 1px solid rgba(244,63,94,.28); border-radius: 999px; background: rgba(244,63,94,.10); color: #fda4af; font: inherit; font-size: 12px; font-weight: 700; outline: none; cursor: pointer; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-auto { background: rgba(29,155,240,.14) !important; color: #8fd3ff !important; font-size: 12px; font-weight: 700; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-auto.is-running { background: rgba(239,68,68,.16) !important; color: #fca5a5 !important; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-clear { font-size: 12px; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-close { width: 38px; padding: 0 !important; font-size: 20px; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 14px; scrollbar-gutter: stable; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-grid { column-width: 230px; column-gap: 12px; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-card { position: relative; display: inline-block; width: 100%; margin: 0 0 12px; overflow: hidden; break-inside: avoid; border-radius: 12px; background: #151518; vertical-align: top; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-card.is-saved { box-shadow: inset 0 0 0 2px rgba(74,222,128,.56); }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-saved-badge { position: absolute; top: 8px; right: 8px; z-index: 2; display: none; align-items: center; min-height: 26px; padding: 0 9px; border: 1px solid rgba(134,239,172,.42); border-radius: 999px; background: rgba(15,23,18,.86); color: #86efac; box-shadow: 0 3px 12px rgba(0,0,0,.34); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); font-size: 11px; font-weight: 750; pointer-events: none; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-card.is-saved .lakomics-x-gallery-saved-badge { display: inline-flex; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-image-link { display: block; text-decoration: none; background: #111; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-image { display: block; width: 100%; height: auto; max-height: none; object-fit: contain; user-select: none; -webkit-user-drag: none; touch-action: manipulation; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-footer { min-height: 34px; padding: 8px 10px; display: flex; align-items: center; gap: 10px; color: #d4d4d8; background: #151518; font-size: 12px; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-author { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-likes { flex: 0 0 auto; color: #fb7185; font-size: 11px; font-weight: 750; white-space: nowrap; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-hint { margin-left: auto; color: #71717a; white-space: nowrap; }
        #${GALLERY_ROOT_ID} .lakomics-x-gallery-empty { max-width: 440px; margin: 18vh auto 0; padding: 28px; text-align: center; color: #a1a1aa; line-height: 1.6; }
        @media (max-width: 720px) {
          #${GALLERY_ROOT_ID} .lakomics-x-gallery-trigger { top: 62px; right: 10px; height: 36px; padding: 0 10px; }
          #${GALLERY_ROOT_ID} .lakomics-x-gallery-header { min-height: 56px; padding: 7px 10px; gap: 5px; }
          #${GALLERY_ROOT_ID} .lakomics-x-gallery-title { font-size: 16px; }
          #${GALLERY_ROOT_ID} .lakomics-x-gallery-header button { min-height: 34px; padding: 0 9px; }
          #${GALLERY_ROOT_ID} .lakomics-x-gallery-like-filter { width: 92px; padding-left: 8px; font-size: 11px; }
          #${GALLERY_ROOT_ID} .lakomics-x-gallery-scroll { padding: 8px; }
          #${GALLERY_ROOT_ID} .lakomics-x-gallery-grid { column-width: 160px; column-gap: 8px; }
          #${GALLERY_ROOT_ID} .lakomics-x-gallery-card { margin-bottom: 8px; border-radius: 9px; }
          #${GALLERY_ROOT_ID} .lakomics-x-gallery-hint { display: none; }
          #${GALLERY_ROOT_ID} .lakomics-x-gallery-footer { gap: 7px; }
        }
        @media (max-width: 430px) {
          #${GALLERY_ROOT_ID} .lakomics-x-gallery-title { font-size: 15px; }
          #${GALLERY_ROOT_ID} .lakomics-x-gallery-auto { font-size: 11px; }
          #${GALLERY_ROOT_ID} .lakomics-x-gallery-clear { display: none; }
        }
        @media (prefers-reduced-motion: reduce) {
          #${GALLERY_ROOT_ID} * { scroll-behavior: auto !important; transition: none !important; }
        }
      </style>
      <button class="lakomics-x-gallery-trigger" type="button" aria-label="추천 이미지 갤러리" aria-expanded="false">
        <span class="lakomics-x-gallery-trigger-icon" aria-hidden="true">▦</span>
        <span class="lakomics-x-gallery-trigger-count">0</span>
      </button>
      <section class="lakomics-x-gallery-overlay" role="dialog" aria-modal="true" aria-label="추천 이미지" hidden>
        <header class="lakomics-x-gallery-header">
          <div class="lakomics-x-gallery-title-wrap">
            <h2 class="lakomics-x-gallery-title">추천 이미지</h2>
            <div class="lakomics-x-gallery-summary">0 images · 0 posts</div>
            <div class="lakomics-x-gallery-harvest-status" hidden></div>
          </div>
          <select class="lakomics-x-gallery-like-filter" aria-label="좋아요 필터" title="좋아요 수로 갤러리 필터">
            <option value="0">전체</option>
            <option value="1000">♥ 1천+</option>
            <option value="5000">♥ 5천+</option>
            <option value="10000">♥ 1만+</option>
          </select>
          <button class="lakomics-x-gallery-auto" type="button" title="추천 피드를 자동으로 내려 새 이미지 100장을 수집하고 시작 위치로 돌아갑니다">▶ 자동 수집</button>
          <button class="lakomics-x-gallery-clear" type="button" title="이번 세션 수집 목록 비우기">초기화</button>
          <button class="lakomics-x-gallery-close" type="button" aria-label="갤러리 닫기" title="닫기">✕</button>
        </header>
        <div class="lakomics-x-gallery-scroll">
          <div class="lakomics-x-gallery-empty">추천 탭에서 <b>자동 수집</b>을 누르면 뒤의 피드가 알아서 내려가며 새 이미지 최대 100장을 모읍니다. 평소처럼 직접 스크롤해도 계속 수집됩니다.</div>
          <div class="lakomics-x-gallery-grid"></div>
        </div>
      </section>
    `;
    document.documentElement.append(root);
    return {
      root,
      trigger: root.querySelector(".lakomics-x-gallery-trigger"),
      triggerCount: root.querySelector(".lakomics-x-gallery-trigger-count"),
      overlay: root.querySelector(".lakomics-x-gallery-overlay"),
      close: root.querySelector(".lakomics-x-gallery-close"),
      clear: root.querySelector(".lakomics-x-gallery-clear"),
      auto: root.querySelector(".lakomics-x-gallery-auto"),
      likeFilter: root.querySelector(".lakomics-x-gallery-like-filter"),
      summary: root.querySelector(".lakomics-x-gallery-summary"),
      harvestStatus: root.querySelector(".lakomics-x-gallery-harvest-status"),
      empty: root.querySelector(".lakomics-x-gallery-empty"),
      scroll: root.querySelector(".lakomics-x-gallery-scroll"),
      grid: root.querySelector(".lakomics-x-gallery-grid"),
    };
  }
})();
