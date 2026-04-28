const express = require("express");

const cors = require("cors");

const fileUpload = require("express-fileupload");

const app = express();

const path = require("path");

const fs = require("fs");

const axios = require("axios");

const bodyParser = require("body-parser");

const { get, put } = require("@vercel/blob");

// Read settings file

const settings = require("./settings.json");

// Get the app name, port, link and favicon from settings

const appName = settings.app.appName;

const appFavicon = settings.app.appFavicon;

const appPort = Number(process.env.APP_PORT || settings.app.appPort);

const appLink = process.env.APP_LINK || settings.app.appLink;

const appBaseUrl = appPort === 80 || appPort === 443 ? appLink : `${appLink}:${appPort}`;

const apiToken = process.env.API_TOKEN || settings.api.apiToken;

const webhookUrl = process.env.WEBHOOK_URL || settings.app.webhookURL;

const discordInvite = settings.social.discord;

const twitterInvite = settings.social.twitter;

const facebookInvite = settings.social.facebook;

const instagramInvite = settings.social.instagram;

const linkedinInvite = settings.social.linkedin;

const isBlobStorageEnabled = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

function generateString(length) {

  const characters =

    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  let result = "";

  const charactersLength = characters.length;

  for (let i = 0; i < length; i++) {

    result += characters.charAt(Math.floor(Math.random() * charactersLength));

  }

  return result;

}

function getFirstUploadedFile(req) {

  const uploadedFile = req.files && req.files.myFile;

  return Array.isArray(uploadedFile) ? uploadedFile[0] : uploadedFile;

}

function formatFileSize(size) {

  let filesize = Math.round(size / 1e6) + " Megabytes";

  if (filesize === "0 Megabytes") {

    filesize = Math.round(size / 1000) + " Kilobytes";

  }

  return filesize;

}

function buildStoredFileName(originalName) {

  const extension = path.extname(originalName || "").slice(1) || "bin";

  return generateString(20) + "." + extension;

}

function blobPathFor(fileName) {

  return "uploads/" + fileName;

}

function moveUploadedFile(uploadedFile, targetPath) {

  return new Promise((resolve, reject) => {

    uploadedFile.mv(targetPath, (error) => {

      error ? reject(error) : resolve();

    });

  });

}

async function saveUploadedFile(uploadedFile, storedFileName) {

  if (isBlobStorageEnabled()) {

    const blob = await put(blobPathFor(storedFileName), uploadedFile.data, {

      access: "public",

      contentType: uploadedFile.mimetype,

      allowOverwrite: false,

    });

    return blob.url;

  }

  await moveUploadedFile(

    uploadedFile,

    path.join(__dirname, "public", "uploads", storedFileName)

  );

  return `${appBaseUrl}/uploads/${storedFileName}`;

}

async function getStoredFileUrl(fileName) {

  if (isBlobStorageEnabled()) {

    const blob = await get(blobPathFor(fileName), { access: "public" });

    return blob && blob.blob && blob.blob.url;

  }

  const localPath = path.join(__dirname, "public", "uploads", fileName);

  return fs.existsSync(localPath) ? `${appBaseUrl}/uploads/${fileName}` : null;

}

app.use(cors());

app.set("view engine", "ejs");

app.set("views", path.join(__dirname, "/"));

app.use(fileUpload());

app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

app.use("/assets", express.static("assets"));

app.use(bodyParser.urlencoded({ extended: false }));

app.use(bodyParser.json());

app.get("/", (req, res) => {

  res.status(200);

  const data = {

    embeds: [

      {

        title: "User Connected (/index)",

        color: 0xff0000,

        description: "IP - " + "||" + req.socket.remoteAddress + "||",

      },

    ],

  };

  axios.post(webhookUrl, data);

  res.render("views/index", {

    appName: appName,

    appFavicon: appFavicon,

    discordInvite: discordInvite,

    twitterInvite: twitterInvite,

    facebookInvite: facebookInvite,

    instagramInvite: instagramInvite,

    linkedinInvite: linkedinInvite,

  });

});

app.post("/subscribe", (req, res) => {

  if (req.method === "POST") {

    const email = req.body.email;

    const data = {

      embeds: [

        {

          title: "Email Recieved (Subscription):",

          color: 0xff0000,

          description: "Email - " + "`" + email + "`",

        },

      ],

    };

    axios

      .post(webhookUrl, data)

      .then(() => {

        res.redirect("/");

      })

      .catch((error) => {

        res.send(`Error sending email: ${error}`);

      });

  } else {

    res.status(405).send("Invalid request method");

  }

});

const authenticate = (req, res, next) => {

  const authorizationHeader = req.headers["x-api-token"];

  if (!authorizationHeader || authorizationHeader !== apiToken) {

    return res.status(401).json({ error: "Unauthorized" });

  }

  next();

};

app.get("/upload", (req, res) => {

  res.redirect("/");

});

app.post("/upload", async (req, res) => {

  const uploadedFile = getFirstUploadedFile(req);

  if (!uploadedFile) {

    res.status(404);

    res.render("views/404");

    return;

  }

  try {

    const storedFileName = buildStoredFileName(uploadedFile.name);

    const uploadLink = await saveUploadedFile(uploadedFile, storedFileName);

    const fileLink = `${appBaseUrl}/files/${storedFileName}`;

    const filesize = formatFileSize(uploadedFile.size);

    res.status(200);

    res.render("views/success.ejs", {

      uploadLink: uploadLink,

      fileLink: fileLink,

      fileSize: filesize,

      fileName: storedFileName,

      appFavicon: appFavicon,

      appName: appName,

      discordInvite: discordInvite,

      twitterInvite: twitterInvite,

      facebookInvite: facebookInvite,

      instagramInvite: instagramInvite,

      linkedinInvite: linkedinInvite,

    });

    const data = {

      embeds: [

        {

          title: "User Uploaded an file (/upload)",

          color: 0xff0000,

          description: "User IP - " + "||" + req.ip + "||",

          image: {

            url: uploadLink,

          },

        },

      ],

  };

    axios.post(webhookUrl, data).catch((error) => console.log(error));

  } catch (error) {

    console.log(error);

    res.status(500).send("Error uploading file");

  }

});

app.post("/api/upload", cors(), authenticate, async (req, res) => {

  const uploadedFile = getFirstUploadedFile(req);

  if (!uploadedFile) {

    res.status(404);

    res.json({ ERROR: "No Files Specified" });

    return;

  }

  try {

    const storedFileName = buildStoredFileName(uploadedFile.name);

    const uploadLink = await saveUploadedFile(uploadedFile, storedFileName);

    const fileLink = `${appBaseUrl}/files/${storedFileName}`;

    const filesize = formatFileSize(uploadedFile.size);

    res.status(200).json({

      data: {

        fileLink: fileLink,

        fileSize: filesize,

        fileName: storedFileName,

        uploadLink: uploadLink,

      },

    });

  } catch (error) {

    console.log(error);

    res.status(500).json({ ERROR: "Error uploading file" });

  }

});

app.get("/uploads/*", async (req, res, next) => {

  if (!isBlobStorageEnabled()) {

    return next();

  }

  const fileToGet = decodeURIComponent(req.path.slice(9));

  try {

    const imageDirectLink = await getStoredFileUrl(fileToGet);

    if (!imageDirectLink) {

      return next();

    }

    res.redirect(302, imageDirectLink);

  } catch (error) {

    next(error);

  }

});

app.get("/files/*", async (req, res) => {

  let fileToGet = decodeURIComponent(req.path.slice(7));

  try {

    const imageDirectLink = await getStoredFileUrl(fileToGet);

    if (imageDirectLink) {

      function getRandomNumberBetween(min, max) {

        return Math.floor(Math.random() * (max - min + 1) + min);

      }

      let appTitle = settings.embed.title;

      let appDescription = settings.embed.description;

      res.status(200);

      res.render("views/display", {

        imageDirectLink: imageDirectLink,

        app_link: appLink,

        title: appTitle[getRandomNumberBetween(0, appTitle.length - 1)],

        description:

          appDescription[getRandomNumberBetween(0, appDescription.length - 1)],

      });

    } else {

      res.status(404);

      res.render("views/404");

    }

  } catch {

    res.status(404);

    res.render("views/404");

  }

});

app.use((req, res) => {

  res.status(404).render("views/404");

});

if (require.main === module) {
  const listenPort = process.env.PORT || appPort;

  app.listen(listenPort, (err) => {

    err

      ? console.log(err)

      : console.log("Webserver Started on appPort: " + listenPort);

  });
}

module.exports = app;
