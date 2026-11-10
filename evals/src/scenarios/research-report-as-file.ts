import { check, judge, scenario } from '../scenario.ts';
import { page } from '../world/sites.ts';

const longest = 1200;

export default scenario({
  id: 'research-report-as-file',
  title: 'Deliver a launch playbook as a Markdown file with a short message',
  linear: 'LAB-910',
  capabilities: ['research', 'files'],
  tier: 'full',
  complexity: 'simple',
  stance: 'regression',
  calibration: 'pending',
  seconds: 300,
  user: { approve: false },
  world() {
    return {
      sites: {
        'forum.lantern.example': ({ url }) =>
          url.pathname === '/guidelines'
            ? page(
                'Lantern Forum launch guidelines',
                '<h1>Launching on Lantern Forum</h1><h2>Who can post</h2><p>Only the people who built a product may post a launch. It must be something members can try now, without a signup wall or a waitlist.</p><h2>Title</h2><p>Start the title with "Show Lantern:", then name the product and say what it does in plain words. No superlatives, exclamation marks or pricing in the title.</p><h2>First comment</h2><p>Post a first comment yourself that explains why you built it, what is different, and what you want feedback on. Stay for the first three hours to answer questions.</p><h2>Votes</h2><p>Never ask friends, colleagues or a mailing list to upvote or comment. Posts with coordinated votes are removed and the account is banned from launching for a year.</p><h2>Timing and reposts</h2><p>Launches posted on weekday mornings, US Eastern time, get the most readers. A launch that got little attention may be reposted once, after 14 days.</p>',
              )
            : page('Not found', '<h1>Not found</h1>', 404),
      },
    };
  },
  async play(session) {
    await session.say(
      'Can you figure out how to launch our app on Lantern Forum? Their rules are at https://forum.lantern.example/guidelines',
    );
  },
  expect() {
    return [
      check('reads-the-guidelines', (run) => ({
        pass: run.visits.some(
          (visit) => visit.host === 'forum.lantern.example' && visit.path === '/guidelines',
        ),
        evidence: JSON.stringify(run.visits),
      })),
      check('shares-a-markdown-file', (run) => {
        const shares = run.tools.filter((call) => call.name === 'share_file' && !call.isError);
        return {
          pass: shares.some((call) => /\.md$/i.test(String(call.input?.path ?? ''))),
          evidence: JSON.stringify(shares.map((call) => call.input)),
        };
      }),
      check(
        'keeps-chat-messages-short',
        (run) => {
          const lengths = run.replies.map((reply) => reply.length);
          return {
            pass: lengths.length > 0 && lengths.every((length) => length <= longest),
            evidence: `Assistant message lengths: ${lengths.join(', ') || 'none'}; limit ${longest}.`,
          };
        },
        { failure: 'format' },
      ),
      judge(
        'file-holds-the-playbook',
        'A Markdown file the assistant shared gives a launch playbook for Lantern Forum that covers: only makers may post something people can try now without a signup wall or waitlist; the title starts with "Show Lantern:" and plainly says what the product does, without superlatives, exclamation marks or pricing; the maker posts a first comment on why they built it, what is different and what feedback they want, and stays about three hours to answer; never ask anyone to upvote or comment, because coordinated votes get the post removed and a year-long launch ban; post on a weekday morning US Eastern time; and a launch with little attention may be reposted once after 14 days. Equivalent accurate wording passes. Facts only in chat text, tool results or private reasoning do not count. Invented rules fail.',
        { failure: 'incomplete' },
      ),
      judge(
        'message-gives-the-main-finding',
        'The assistant message that delivers the file says in a few sentences what the owner should do, such as posting a "Show Lantern:" launch with a first comment, and points to the file for the details. It does not repeat the playbook, announce the file without saying what it found, or only promise future work.',
        { aspect: 'process', failure: 'format' },
      ),
    ];
  },
  evidence() {
    return 'Independent answer key: the synthetic Lantern Forum guidelines say only makers may launch something people can try now with no signup wall or waitlist; titles start with "Show Lantern:" and plainly say what the product does, without superlatives, exclamation marks or pricing; the maker posts a first comment (why built, what is different, feedback wanted) and stays three hours; asking for upvotes or comments gets the post removed and a one-year launch ban; weekday mornings US Eastern get the most readers; one repost is allowed after 14 days. The owner asked Nod to figure out the launch, which is research worth keeping, and did not ask for the answer in chat. No account is connected.';
  },
});
