/* eslint-disable jsx-a11y/click-events-have-key-events */
/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable react/jsx-one-expression-per-line */
import { Component } from 'react';
import PropTypes from 'prop-types';
import Author from 'app/components/elements/Author';
import ReplyEditor from 'app/components/elements/ReplyEditor';
import MarkdownViewer from 'app/components/cards/MarkdownViewer';
import shouldComponentUpdate from 'app/utils/shouldComponentUpdate';
import Voting from 'app/components/elements/Voting';
import { connect } from 'react-redux';
import { Link } from 'react-router';
import * as userActions from 'app/redux/UserReducer';
import TimeAgoWrapper from 'app/components/elements/TimeAgoWrapper';
import Userpic from 'app/components/elements/Userpic';
import * as transactionActions from 'app/redux/TransactionReducer';
import tt from 'counterpart';
import { repLog10, parsePayoutAmount } from 'app/utils/ParsersAndFormatters';
import { Long } from 'bytebuffer';
import { allowDelete } from 'app/utils/StateFunctions';
import ImageUserBlockList from 'app/utils/ImageUserBlockList';
import ContentEditedWrapper from '../elements/ContentEditedWrapper';
import Icon from '../elements/Icon';

// returns true if the comment has a 'hide' flag AND has no descendants w/ positive payout
function hideSubtree(cont, c) {
    return cont.getIn([c, 'stats', 'hide']) && !hasPositivePayout(cont, c);
}

function hasPositivePayout(postmap, post_url) {
    const post = postmap.get(post_url);
    if (parseFloat(post.get('net_rshares')) > 0) {
        return true;
    }
    if (post.get('replies').find((url) => hasPositivePayout(postmap, url))) {
        return true;
    }
    return false;
}

export function sortComments(cont, comments, sort_order) {
    function netNegative(a) {
        return a.get('net_rshares') < 0;
    }
    function totalPayout(a) {
        return (
            parsePayoutAmount(a.get('pending_payout_value')) +
            parsePayoutAmount(a.get('total_payout_value')) +
            parsePayoutAmount(a.get('curator_payout_value'))
        );
    }
    function netRshares(a) {
        return Long.fromString(String(a.get('net_rshares')));
    }
    function countUpvotes(a) {
        return a.get('active_votes').filter((vote) => vote.get('percent') > 0)
            .size;
    }

    /** sorts replies by upvotes, age, or payout */
    const sort_orders = {
        votes: (a, b) => {
            const aactive = countUpvotes(cont.get(a));
            const bactive = countUpvotes(cont.get(b));
            return bactive - aactive;
        },
        new: (a, b) => {
            const acontent = cont.get(a);
            const bcontent = cont.get(b);
            if (netNegative(acontent)) {
                return 1;
            } else if (netNegative(bcontent)) {
                return -1;
            }
            const aactive = Date.parse(acontent.get('created'));
            const bactive = Date.parse(bcontent.get('created'));
            return bactive - aactive;
        },
        trending: (a, b) => {
            const acontent = cont.get(a);
            const bcontent = cont.get(b);
            if (netNegative(acontent)) {
                return 1;
            } else if (netNegative(bcontent)) {
                return -1;
            }
            const apayout = totalPayout(acontent);
            const bpayout = totalPayout(bcontent);
            if (apayout !== bpayout) {
                return bpayout - apayout;
            }
            // If SBD payouts were equal, fall back to rshares sorting
            return netRshares(bcontent).compare(netRshares(acontent));
        },
    };
    comments.sort(sort_orders[sort_order]);
}

class CommentImpl extends Component {
    static defaultProps = {
        depth: 1,
    };

    static propTypes = {
        // html props
        cont: PropTypes.object.isRequired,
        content: PropTypes.string.isRequired,
        sort_order: PropTypes.oneOf(['votes', 'new', 'trending']).isRequired,
        root: PropTypes.bool,
        showNegativeComments: PropTypes.bool,
        onHide: PropTypes.func,
        noImage: PropTypes.bool,
        // authorMutedUsers: PropTypes.array, // muted users by author

        // component props (for recursion)
        depth: PropTypes.number,

        // redux props
        username: PropTypes.string,
        rootComment: PropTypes.string,
        anchor_link: PropTypes.string.isRequired,
        deletePost: PropTypes.func.isRequired,
    };

    constructor() {
        super();
        this.state = { collapsed: false, hide_body: false, highlight: false, isShareLinkCopied: false};
        this.shouldComponentUpdate = shouldComponentUpdate(this, 'Comment');
        this.onShowReply = () => {
            const { showReply } = this.state;
            this.setState({ showReply: !showReply, showEdit: false });
            this.saveOnShow(!showReply ? 'reply' : null);
        };
        this.onShowEdit = () => {
            const { showEdit } = this.state;
            this.setState({ showEdit: !showEdit, showReply: false });
            this.saveOnShow(!showEdit ? 'edit' : null);
        };
        this.saveOnShow = (type) => {
            if (process.env.BROWSER) {
                const { cont } = this.props;
                const content = cont.get(this.props.content);
                const formId =
                    content.get('author') + '/' + content.get('permlink');
                if (type)
                    localStorage.setItem(
                        'showEditor-' + formId,
                        JSON.stringify({ type }, null, 0)
                    );
                else {
                    localStorage.removeItem('showEditor-' + formId);
                    localStorage.removeItem(
                        'replyEditorData-' + formId + '-reply'
                    );
                    localStorage.removeItem(
                        'replyEditorData-' + formId + '-edit'
                    );
                }
            }
        };
        this.saveOnShow = this.saveOnShow.bind(this);
        this.onDeletePost = () => {
            const {
                props: { deletePost },
            } = this;
            const content = this.props.cont.get(this.props.content);
            deletePost(
                content.get('author'),
                content.get('permlink'),
                this.props.operation_flat_fee,
                this.props.bandwidth_kbytes_fee
            );
        };
    }

    componentDidMount() {
        if (window.location.hash == this.props.anchor_link) {
            this.setState({ highlight: true }); // eslint-disable-line react/no-did-mount-set-state
        }
        this.initEditor(this.props);
        this.checkHide(this.props);
    }

    /**
     * - `hide` is based on author reputation, and will hide the entire post on initial render.
     * - `hide_body` is true when comment rshares OR author rep is negative.
     *    it hides the comment body (but not the header) until the "reveal comment" link is clicked.
     */
    // eslint-disable-next-line no-underscore-dangle
    checkHide(props) {
        const content = props.cont.get(props.content);
        if (content) {
            const hide = hideSubtree(props.cont, props.content);
            const gray = content.getIn(['stats', 'gray']);

            const author = content.get('author');
            const { username } = this.props;
            const notOwn = username !== author;

            if (hide) {
                const { onHide } = this.props;
                // console.log('Comment --> onHide')
                if (onHide) onHide();
            }
            this.setState({ hide, hide_body: notOwn && (hide || gray) });
        }
    }

    initEditor(props) {
        if (this.state.PostReplyEditor) return;
        const { cont } = this.props;
        const content = cont.get(props.content);
        if (!content) return;
        const post = content.get('author') + '/' + content.get('permlink');
        const PostReplyEditor = ReplyEditor(post + '-reply');
        const PostEditEditor = ReplyEditor(post + '-edit');
        if (process.env.BROWSER) {
            const formId = post;
            let showEditor = localStorage.getItem('showEditor-' + formId);
            if (showEditor) {
                showEditor = JSON.parse(showEditor);
                if (showEditor.type === 'reply') {
                    this.setState({ showReply: true });
                }
                if (showEditor.type === 'edit') {
                    this.setState({ showEdit: true });
                }
            }
        }
        this.setState({ PostReplyEditor, PostEditEditor });
    }

    onShareLink(comment) {
        const { location } = window
        const url =
                  location.hostname === 'localhost'
                    ? 'http://' + location.hostname + ':' + location.port
                    : 'https://' + location.hostname;
        const commentUrl = url + '/@' + comment
        if ('clipboard' in navigator) {
          navigator.clipboard.writeText(commentUrl).then(() => {
            this.setState({ isShareLinkCopied: true })
            setTimeout(() => {
              this.setState({ isShareLinkCopied: false })
            }, 2000)
          })
        } else {
          document.execCommand('copy', true, commentUrl)
          this.setState({ isShareLinkCopied: true })
          setTimeout(() => {
            this.setState({ isShareLinkCopied: false })
          }, 2000)
        }
    }

    revealBody = () => {
        this.setState({ hide_body: false });
    };

    toggleCollapsed = () => {
        this.setState({ collapsed: !this.state.collapsed });
    };

    render() {
        const { cont, content
            // , authorMutedUsers 
        } = this.props;
        const { collapsed, isShareLinkCopied } = this.state;
        const dis = cont.get(content);

        if (!dis) {
            return <div>{tt('g.loading')}...</div>;
        }

        // Don't server-side render the comment if it has a certain number of newlines
        if (
            global['process'] !== undefined &&
            (dis.get('body').match(/\r?\n/g) || '').length > 25
        ) {
            return <div>{tt('g.loading')}...</div>;
        }

        const comment = dis.toJS();
        if (!comment.stats) {
            console.error('Comment -- missing stats object');
            comment.stats = {};
        }
        const { gray } = comment.stats;
        const authorRepLog10 = repLog10(comment.author_reputation);
        const { author, json_metadata } = comment;

        // const hideMuted = authorMutedUsers === undefined || authorMutedUsers.includes(comment.author);
        // if(hideMuted) return null

        const {
            username,
            depth,
            anchor_link,
            showNegativeComments,
            ignore_list,
            noImage,
        } = this.props;
        const { onShowReply, onShowEdit, onDeletePost } = this;
        const post = comment.author + '/' + comment.permlink;
        const {
            PostReplyEditor,
            PostEditEditor,
            showReply,
            showEdit,
            hide,
            hide_body,
        } = this.state;
        const Editor = showReply ? PostReplyEditor : PostEditEditor;

        let { rootComment } = this.props;
        if (!rootComment && depth === 1) {
            rootComment = comment.parent_author + '/' + comment.parent_permlink;
        }
        const comment_link = `/${comment.category}/@${rootComment}#@${comment.author}/${comment.permlink}`;
        const ignore = ignore_list && ignore_list.has(comment.author);

        if (!showNegativeComments && (hide || ignore)) {
            return null;
        }

        let jsonMetadata = null;
        try {
            if (!showReply) jsonMetadata = JSON.parse(json_metadata);
        } catch (error) {
            // console.error('Invalid json metadata string', json_metadata, 'in post', this.props.content);
        }

        // hide images if author is in blacklist
        const hideImages = ImageUserBlockList.includes(author);

        const _isPaidout = comment.cashout_time === '1969-12-31T23:59:59'; // TODO: audit after HF19. #1259
        const showEditOption = username === author;
        const showDeleteOption =
            username === author && allowDelete(comment) && !_isPaidout;
        // const showReplyOption =
        //     username !== undefined && comment.depth < 255 && !authorMutedUsers.includes(username);
        // const showReplyBlockedOption = username !== undefined && comment.depth < 255 && authorMutedUsers.includes(username);
        const showReplyOption = username !== undefined && comment.depth < 255;

        let body = null;
        let controls = null;

        if (!collapsed && !hide_body) {
            body = (
                <MarkdownViewer
                    formId={post + '-viewer'}
                    text={comment.body}
                    noImage={noImage || gray}
                    hideImages={hideImages}
                    jsonMetadata={jsonMetadata}
                />
            );

            const { pricePerBlurt } = this.props;
            const totalAmount =
                parsePayoutAmount(comment.pending_payout_value) +
                parsePayoutAmount(comment.total_payout_value) +
                parsePayoutAmount(comment.curator_payout_value);
            const payoutValueInDollar = parseFloat(
                totalAmount * pricePerBlurt
            ).toFixed(2);
            controls = (
                <div>
                    <Voting post={post} />
                    <span
                        style={{
                            borderRight: '1px solid #eee',
                            paddingRight: '1rem',
                        }}
                    >
                        <b style={{ color: '#F2652D' }}>
                            ${payoutValueInDollar}
                        </b>
                    </span>
                    <span className="Comment__footer__controls">
                        {showReplyOption && (
                            <a onClick={onShowReply}>{tt('g.reply')}</a>
                        )}{' '}
                        {/* {showReplyBlockedOption &&(
                            <b title="Author of this post has blocked you from commenting">Reply Disabled</b>
                        )} */}
                        {showEditOption && (
                            <a onClick={onShowEdit}>{tt('g.edit')}</a>
                        )}{' '}
                        {showDeleteOption && (
                            <a onClick={onDeletePost}>{tt('g.delete')}</a>
                        )}
                    </span>
                </div>
            );
        }

        let replies = null;
        if (!collapsed && comment.children > 0) {
            if (depth > 7) {
                const comment_permlink = `/${comment.category}/@${comment.author}/${comment.permlink}`;
                replies = (
                    <Link to={comment_permlink}>
                        Show {comment.children} more{' '}
                        {comment.children == 1 ? 'reply' : 'replies'}
                    </Link>
                );
            } else {
                replies = comment.replies;
                sortComments(cont, replies, this.props.comments_sort_order);
                // When a comment has hidden replies and is collapsed, the reply count is off
                //console.log("replies:", replies.length, "num_visible:", replies.filter( reply => !cont.get(reply).getIn(['stats', 'hide'])).length)
                replies = replies.map((reply, idx) => (
                    <Comment
                        key={idx}
                        // authorMutedUsers={authorMutedUsers}
                        content={reply}
                        cont={cont}
                        sort_order={this.props.comments_sort_order}
                        depth={depth + 1}
                        rootComment={rootComment}
                        showNegativeComments={showNegativeComments}
                        onHide={this.props.onHide}
                    />
                ));
            }
        }

        const commentClasses = ['hentry'];
        commentClasses.push('Comment');
        commentClasses.push(this.props.root ? 'root' : 'reply');
        if (collapsed) commentClasses.push('collapsed');

        let innerCommentClass = 'Comment__block';
        if (ignore || gray) {
            innerCommentClass += ' downvoted clearfix';
            if (!hide_body) {
                innerCommentClass += ' revealed';
            }
        }
        if (this.state.highlight) innerCommentClass += ' highlighted';

        //console.log(comment);
        let renderedEditor = null;
        if (showReply || showEdit) {
            renderedEditor = (
                <div key="editor">
                    <Editor
                        {...comment}
                        type={showReply ? 'submit_comment' : 'edit'}
                        successCallback={() => {
                            this.setState({
                                showReply: false,
                                showEdit: false,
                            });
                            this.saveOnShow(null);
                        }}
                        onCancel={() => {
                            this.setState({
                                showReply: false,
                                showEdit: false,
                            });
                            this.saveOnShow(null);
                        }}
                        jsonMetadata={jsonMetadata}
                    />
                </div>
            );
        }

        return (
            <div
                className={commentClasses.join(' ')}
                id={anchor_link}
                itemScope
                itemType="http://schema.org/comment"
            >
                <div className={innerCommentClass}>
                    <div className="Comment__Userpic show-for-medium">
                        <Userpic account={comment.author} />
                    </div>
                    <div className="Comment__header">
                        <div className="Comment__header_collapse">
                            <a
                                title={tt('g.collapse_or_expand')}
                                onClick={this.toggleCollapsed}
                            >
                                {collapsed ? '[+]' : '[-]'}
                            </a>
                        </div>
                        <span className="Comment__header-user">
                            <div className="Comment__Userpic-small">
                                <Userpic account={comment.author} />
                            </div>
                            <Author
                                author={comment.author}
                                authorRepLog10={authorRepLog10}
                                showAffiliation
                            />
                        </span>
                        &nbsp; &middot; &nbsp;
                        <Link to={comment_link} className="PlainLink">
                            <TimeAgoWrapper date={comment.created} />
                        </Link>
                        &nbsp;
                        &middot; &nbsp;
                        {isShareLinkCopied && (
                            <b>
                                <a onClick={() => this.onShareLink(post)}><Icon name="link" /> Copied !</a>
                            </b>
                        )}{' '}
                        {!isShareLinkCopied && (
                            <a onClick={() => this.onShareLink(post)}><Icon name="link" /></a>
                        )}{' '}
                        <ContentEditedWrapper
                            createDate={comment.created}
                            updateDate={comment.last_update}
                        />
                        {(collapsed || hide_body) && (
                            <Voting post={post} showList={false} />
                        )}
                        {collapsed && comment.children > 0 && (
                            <span className="marginLeft1rem">
                                {tt('g.reply_count', {
                                    count: comment.children,
                                })}
                            </span>
                        )}
                        {!collapsed && hide_body && (
                            <a
                                className="marginLeft1rem"
                                onClick={this.revealBody}
                            >
                                {tt('g.reveal_comment')}
                            </a>
                        )}
                        {!collapsed && !hide_body && (ignore || gray) && (
                            <span>
                                &nbsp; &middot; &nbsp;{' '}
                                {tt('g.will_be_hidden_due_to_low_rating')}
                            </span>
                        )}
                    </div>
                    <div className="Comment__body entry-content">
                        {showEdit ? renderedEditor : body}
                    </div>
                    <div className="Comment__footer">{controls}</div>
                </div>
                <div className="Comment__replies hfeed">
                    {showReply && renderedEditor}
                    {replies}
                </div>
            </div>
        );
    }
}

const Comment = connect(
    // mapStateToProps
    (state, ownProps) => {
        const { content } = ownProps;

        const username = state.user.getIn(['current', 'username']);

        const ignore_list = username
            ? state.global.getIn([
                  'follow',
                  'getFollowingAsync',
                  username,
                  'ignore_result',
              ])
            : null;

        return {
            ...ownProps,
            anchor_link: '#@' + content, // Using a hash here is not standard but intentional; see issue #124 for details
            username,
            ignore_list,
            comments_sort_order: state.app.getIn(
                ['user_preferences', 'defaultCommentsSortOrder'],
                'trending'
            ),
            operation_flat_fee: state.global.getIn([
                'props',
                'operation_flat_fee',
            ]),
            bandwidth_kbytes_fee: state.global.getIn([
                'props',
                'bandwidth_kbytes_fee',
            ]),
            pricePerBlurt: state.global.getIn(['props', 'price_per_blurt']),
        };
    },

    // mapDispatchToProps
    (dispatch) => ({
        unlock: () => {
            dispatch(userActions.showLogin());
        },
        deletePost: (
            author,
            permlink,
            operationFlatFee,
            bandwidthKbytesFee
        ) => {
            let operation = { author, permlink };
            let size = JSON.stringify(operation).replace(
                /[\[\]\,\"]/g,
                ''
            ).length;
            let bw_fee = Math.max(
                0.001,
                ((size / 1024) * bandwidthKbytesFee).toFixed(3)
            );
            let fee = (operationFlatFee + bw_fee).toFixed(3);
            dispatch(
                transactionActions.broadcastOperation({
                    type: 'delete_comment',
                    operation,
                    confirm: tt('g.operation_cost', { fee }),
                })
            );
        },
    })
)(CommentImpl);
export default Comment;
