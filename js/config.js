/* FlickAtlas config — single source of truth.
   BASE is the site's public address. When the custom domain is attached,
   flip BASE here (plus the matching BASE in api/sitemap.js and the
   Sitemap line in robots.txt) and everything follows. */
const CONFIG = {
  TMDB_KEY: "340b676f5c88561441b6e38be7f15866",
  IMG: "https://image.tmdb.org/t/p",
  BASE: "https://flickatlas.co.uk",
  SITE: "FlickAtlas",
  EMAIL: "mkdrivedata@gmail.com"
};

/* Display-currency rates for the header currency switcher. USD is the
   data currency — every figure on the site is stored/computed in USD and
   INR/PKR amounts are display-only conversions at these rates.
   Fetched 23 October 2026 from two public sources: ExchangeRate-API open
   endpoint (updated 23 Oct 2026: INR 94.90, PKR 276.99) and the
   fawazahmed0/currency-api snapshot (22 Oct 2026: INR 94.39, PKR 276.82).
   The two agreed within 0.6%, so the stored values are their averages. */
const FA_RATES = { USD: 1, INR: 94.65, PKR: 276.9, asOf: "23 October 2026" };
