import { respondWithJSON } from "./json";
import { BadRequestError, UserForbiddenError, NotFoundError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { type ApiConfig, cfg } from "../config";
import { s3, type BunRequest } from "bun";
import { setFlagsFromString } from "v8";
import type { Video } from "../db/videos";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }
  
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);
  
  console.log("uploading video", videoId, "by user", userID);

  const video = getVideo(cfg.db, videoId);
  if (!video) throw new NotFoundError("No video corresponding to this ID in the database");
  if (userID !== video.userID) throw new UserForbiddenError("User is not the owner of the video");
  
  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file is missing");
  }
  
  const MAX_UPLOAD_SIZE: number = 1 << 30
  if (file.size > MAX_UPLOAD_SIZE) throw new BadRequestError("Size of the video is too big");

  const fileType = file.type;
  if (fileType !== "video/mp4") throw new BadRequestError("The file sent should be a video");

  const videoBuffer = await file.arrayBuffer();
  const fileExtension = fileType.split("/")[1];
  const fileName = `${videoId}.${fileExtension}`;

  const tempVidFilePath = `${cfg.assetsRoot}/${fileName}`;

  try {

  await Bun.write(tempVidFilePath, videoBuffer);
  const fastStartVid = await processVideoForFastStart(tempVidFilePath);
  if (!fastStartVid) throw new Error("video conversion went bad")
  const vidAspectRatio = await getVideoAspectRatio(fastStartVid);
  if (!vidAspectRatio) throw new Error("Couldn't return the aspect ratio")

  const aspectPrefixedFileName = vidAspectRatio + "/" + fileName;
  const s3Vid = cfg.s3Client.file(aspectPrefixedFileName);
  await s3Vid.write(Bun.file(fastStartVid), {type: "video/mp4"})  
    
  video.videoURL = `https://${cfg.s3CfDistribution}/${aspectPrefixedFileName}`;
  await updateVideo(cfg.db, video);

  const isFastVidHere = await Bun.file(fastStartVid).exists();
  if (isFastVidHere) await Bun.file(fastStartVid).delete();

  } finally {
  
  const isFileThere = await Bun.file(tempVidFilePath).exists();
  if (isFileThere) await Bun.file(tempVidFilePath).delete();
  
  }

  return respondWithJSON(200, video);
}

export async function getVideoAspectRatio(filePath: string) {

  type FFprobeStream = {
    width: number;
    height: number;
  }

  type FFprobeOutput = {
    programs: unknown[];
    streams: FFprobeStream[];
  }

  try {
  const aspectRatioProcess = Bun.spawn([
    "ffprobe", 
    "-v", 
    "error", 
    "-select_streams", 
    "v:0", 
    "-show_entries", 
    "stream=width,height", 
    "-of", 
    "json", 
    filePath], {
      stderr: "pipe"
    });

    const exitCode = await aspectRatioProcess.exited;
    if (exitCode !== 0) throw new Error("Couldn't get video aspect ratio");

    const stdoutText = await new Response(aspectRatioProcess.stdout).text();
    const aspectRatioJSON: FFprobeOutput = JSON.parse(stdoutText);

    const {width, height} = aspectRatioJSON.streams[0];

    let aspectRatio: string

    if ((Math.floor(height) / 9) === (Math.floor(width) / 16)) {
      aspectRatio = "landscape";
    } else if ((Math.floor(height / 16)) === (Math.floor(width / 9))) {
      aspectRatio = "portrait";
    } else {
      aspectRatio = "other"
    }
    
    const stderrText = await new Response(aspectRatioProcess.stderr).text();

    console.log(stderrText);

    return aspectRatio;

  } catch(error) {
    if (error instanceof Error) console.log(error.message);
    return;
  }
  
}

export async function processVideoForFastStart(inputFilePath: string) {

  const pathArray = inputFilePath.split(".");
  const outputFilePath = `.${pathArray[1]}.fast.mp4`;
  const fastStartVid = Bun.spawn([
    "ffmpeg",
    "-i",
    inputFilePath,
    "-movflags",
    "faststart",
    "-map_metadata",
    "0",
    "-codec",
    "copy",
    "-f",
    "mp4",
    outputFilePath
  ], {
    stderr: "pipe"
  })

  const code = await fastStartVid.exited;
  console.log(code);
  if (code === 0) {
    console.log(`file ready at ${outputFilePath}`);
  } else {
    const errorText = await new Response(fastStartVid.stderr).text();
    console.log(errorText);
  }

  return outputFilePath;

}

