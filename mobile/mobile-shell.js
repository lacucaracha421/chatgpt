(() => {
  "use strict";
  const app = document.querySelector("#app");
  const closeSidebar = () => app?.classList.remove("assets-sidebar-open");

  function go(view) {
    document.querySelectorAll(".view").forEach((node) => {
      node.classList.toggle("active", node.dataset.view === view);
    });
    document.querySelectorAll(".nav-btn").forEach((button) => {
      button.classList.toggle("active", button.dataset.nav === view);
    });
    closeSidebar();
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  document.addEventListener("click", (event) => {
    const nav = event.target.closest?.("[data-nav]");
    if (nav) return go(nav.dataset.nav);
    const direct = event.target.closest?.("[data-go]");
    if (direct) return go(direct.dataset.go);
    if (event.target.closest?.("#categoryOpen")) return app?.classList.add("assets-sidebar-open");
    if (event.target.closest?.("#sidebarClose, #sidebarScrim")) return closeSidebar();
    if (event.target.closest?.("#viewerClose")) document.querySelector("#viewer")?.close();
  });
})();