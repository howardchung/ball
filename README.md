# Court reservations – this week
Shows Gilman, Beacon Hill and Miller court reservations for the current week (Mon–Sun) from the Seattle Parks Power BI report.

    npm install
    npm run dev      # open the printed localhost URL

A proxy (vite.config.js) forwards /pbi/* to the Power BI Gov API; the app needs `npm run dev` or `npm run preview`.
Edit `LOCATIONS` in src/App.jsx to change locations.
