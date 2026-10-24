/* Verified TMDB official trailer link; information-only, never an embed. */
window.OfficialTrailers = {
  verified(details) {
    const videos = (details && details.videos && Array.isArray(details.videos.results)) ? details.videos.results : [];
    return videos.find(v => v && v.official === true && v.site === "YouTube" && v.type === "Trailer" && /^[A-Za-z0-9_-]{11}$/.test(v.key || "")) || null;
  },
  watchUpcoming(root) {
    if (!root) return;
    const scan = () => {
      const links = [...root.querySelectorAll('a.card[href^="/movie?id="]')];
      links.forEach((link,index) => {
        if (link.dataset.trailerStatus) return;
        link.dataset.trailerStatus = "pending";
        const label = document.createElement("span"); label.className="card-meta card-trailer-status";
        label.textContent=index<8 ? "Checking official trailer…" : "Trailer status not checked";
        link.querySelector(".card-body")?.append(label);
        const url=new URL(link.href);link.hash="official-trailer";
        if(index>=8)return;
        TMDB.api(`/movie/${url.searchParams.get("id")}/videos`).then(data=>{
          label.textContent=this.verified({videos:data}) ? "Official trailer listed" : "No verified official trailer listed";
          link.dataset.trailerStatus="checked";
        }).catch(()=>{label.textContent="Trailer status unavailable";link.dataset.trailerStatus="unavailable";});
      });
    };
    scan();new MutationObserver(scan).observe(root,{childList:true,subtree:true});
  },
  section(details) {
    const v = this.verified(details);
    return `<section class="content-card official-trailer" id="official-trailer"><h2>Official trailer</h2>${v ? `<p><a class="text-link" href="https://www.youtube.com/watch?v=${v.key}" target="_blank" rel="noopener noreferrer">Official trailer on YouTube</a></p>` : `<p class="prov-note">No verified official trailer is currently listed.</p>`}</section>`;
  }
};
