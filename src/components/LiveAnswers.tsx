"use client";

import type { BubbleData } from "@/lib/types";
import type { FeedItem } from "@/lib/multi-answer";
import { BubbleCloud } from "./BubbleCloud";
import { ChatFeed } from "./ChatFeed";

interface Props {
  bubbles: BubbleData | null | undefined;
  feed: FeedItem[] | null | undefined;
  /** The viewer's own answers, to highlight their bubbles. */
  mine?: string[] | null;
  /** "host" is the big shared screen; "phone" is a player's own screen. */
  variant?: "host" | "phone";
  /** Height of the whole stage (a flex-1 / min-h class works too). */
  className?: string;
  emptyText?: string;
}

/**
 * The live view of a multi-answer question: the interactive bubbles fill the stage and a live
 * chat of who-said-what streams up the left side over them, like a live stream.
 */
export function LiveAnswers({ bubbles, feed, mine, variant = "phone", className = "h-[24rem]", emptyText }: Props) {
  const host = variant === "host";
  return (
    <div className={`relative w-full ${className}`}>
      {/* Absolutely fills the stage, so it works whether the stage has a fixed height or is flex-sized. */}
      <BubbleCloud data={bubbles} mine={mine} emptyText={emptyText} className="absolute inset-0" />
      {feed && feed.length > 0 && (
        <ChatFeed
          items={feed}
          visible={host ? 7 : 5}
          size={host ? "lg" : "sm"}
          className={`absolute bottom-3 left-3 ${host ? "max-h-[70%] w-[min(26rem,46%)]" : "max-h-[58%] w-[78%]"}`}
        />
      )}
    </div>
  );
}
