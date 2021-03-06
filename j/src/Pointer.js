(function (TipTap, _) {

	var Pointer = function (tiptapEvent) {
		
		var debug = true && Pointer.debug && TipTap.settings.debug;

		this.direction = Pointer._DIR_NONE;

		this.identifier = tiptapEvent.identifier;

		// the flag is set if the Pointer has tipped before doing other things. Simplifies FSM logic a lot!!
		this.isTipping = false;

		// to store the list of "pointer" informations for this Pointer during its life
		this.listOfPositions = [];

		// used to store details about the absolute drag: distance (x, y, total), speed (x, y, total), duration
		this.dragDetailsAbsolute = { dx: 0, dy: 0, d: 0, spx: 0, spy: 0, spd: 0, duration_ms: 0 };

		// used to store details about the relative drag (between two last positions)
		this.dragDetailsRelative = { dx: 0, dy: 0, d: 0, spx: 0, spy: 0, spd: 0, duration_ms: 0 };

		// reference to the timer used to switch from tap to tip, allows to kill it when Pointer up early
		this.pressedToTippedTimer = 0;

		// index of the positions list of when the swipe started (to calculate values)
		this.swipeStartPositionIndex = 0;

		// keep a reference to the initial target to force it to new Pointers (fast moves can make mouse move outside of it)
		this.target = this.$target = null;
		this._setTarget$(tiptapEvent.getTarget$());

		// create the Signals to send to listeners
		this.createSignals();

		// we store all positions
		this.storePosition(tiptapEvent);

		md(this + ".new()", debug);

	};

	/* "stateless" finite state machine, shared by all Pointers. Stateless means that each Pointer's state is stored in
	 the Pointer itself. Advantage: ONE FSM for all Pointers => don't recreate the SAME FSM for each Pointer, EACH TIME
	 a new Pointer is created, which wastes some CPU time, and means more GC in the end.
	 */
	Pointer.fsm = new TipTap.Fsm(TipTap.Fsm.DONT_SAVE_STATE);

	// todo: factor similar actions in functions (tip-startDragging-drag and startDragging-drag for example)
	// todo: dragStopped ?
	// in this FSM, all callbacks' "this" refers to the Pointer calling.
	Pointer.fsm.init(
		[
			{
				from:        "start",
				isStart:     true,
				transitions: [
					{
						signal: "pressed",
						to:     "pressing",
						action: function () {
							var debug = true && Pointer.debug && TipTap.settings.debug;
							var position = this.getPosition();

							// start the timer which after the time limit transforms the press (potential tap) to a sure tip
							this.startPressedToTippedTimer();

							// let's tell the world we pressed !
							this.pressed.dispatch();

							md(this + "-fsm(start-pressed-pressing),(" + position.pageX + "px, " + position.pageY + "px)", debug);

						}
					}
				]
			},
			{
				from:        "pressing",
				transitions: [
					{
						signal: "pressedToTipped",
						to:     "tipping",
						action: function () {
							var debug = true && Pointer.debug && TipTap.settings.debug;

							md(this + "-fsm(pressing-pressedToTipped-tipping)", debug);

							/*
							 swipe and dragStop are fully similar and can be done from press or tip. But in the case of coming
							 after a tip, we need to send untip at the end. A flag allows to avoid FSM states duplication
							 */
							this.isTipping = true;

							this.tipped.dispatch();

						}
					},
					{
						signal: "dragged",
						to:     TipTap.Fsm._CALC,
						action: function () {

							return this.fsmDraggedTransition();

						}
					},
					{
						signal: ["ended", "cancelled"],
						to:     "end",
						action: function () {

							var debug = true && Pointer.debug && TipTap.settings.debug;

							this.cancelPressedToTippedTimer();

							md(this + "-fsm(pressing-ended-end)", debug);

							this.tapped.dispatch();

							this.released.dispatch();

						}
					}
				]
			},
			{
				from:        "tipping",
				transitions: [
					{
						signal: "dragged",
						to:     TipTap.Fsm._CALC,
						action: function () {

							return this.fsmDraggedTransition();

						}
					},
					{
						signal: ["ended", "cancelled"],
						to:     "end",
						action: function () {
							var debug = true && Pointer.debug && TipTap.settings.debug;

							md(this + "-fsm(tipping-ended)", debug);

							this.untipped.dispatch();

							this.released.dispatch();

						}
					}
				]
			},
			{
				from:        "dragging",
				transitions: [
					{
						signal: "dragged",
						action: function () {
							var debug = true && Pointer.debug && TipTap.settings.debug;

							md(this + "-fsm(dragging-dragged-1)", debug);

							this.dragged.dispatch();

						}
					},
					{
						signal: ["ended", "cancelled"],
						to:     "end",
						action: function () {
							var debug = true && Pointer.debug && TipTap.settings.debug;

							this.dragStopped.dispatch();

							md(this + "-fsm(dragging-ended-1)", debug);

							// usage of this flag simplifies the Fsm
							if (this.isTipping) {

								this.untipped.dispatch();

							}

							this.released.dispatch();

						}
					}
				]
			},
			{
				from:        "swiping",
				transitions: [
					{
						signal: "dragged",
						to:     TipTap.Fsm._CALC,
						action: function () {
							var debug = true && Pointer.debug && TipTap.settings.debug;

							// if the movement is too much for being a swipe, convert it down to a normal drag
							if (!this.notSwipingAnymore()) {

								return TipTap.Fsm._SELF;

							}

							this.dragStarted.dispatch();

							md(this + "-fsm(swiping-dragged-1)", debug);

							this.dragged.dispatch();

							return "dragging";
						}

					},
					{
						signal: ["ended", "cancelled"],
						to:     "end",
						action: function () {
							var debug = true && Pointer.debug && TipTap.settings.debug;

							md(this + "-fsm(swiping-ended-1)", debug);

							this.swiped.dispatch();

							// usage of this flag simplifies the Fsm
							if (this.isTipping) {

								this.untipped.dispatch();

							}

							this.released.dispatch();

						}
					}
				]
			}
		]
	);

	Pointer._DIR_NONE = 0;
	Pointer._DIR_TOP = 1;
	Pointer._DIR_RIGHT = 2;
	Pointer._DIR_BOTTOM = 4;
	Pointer._DIR_LEFT = 8;

	Pointer.prototype = {

		addPosition: function (position) {

			this.listOfPositions.push(position);

		},

		cancelPressedToTippedTimer: function () {

			var debug = true && Pointer.debug && TipTap.settings.debug;

			md(this + ".cancelPressedToTippedTimer-1", debug);

			if (this.pressedToTippedTimer) {

				md(this + ".cancelPressedToTippedTimer-2", debug);

				clearTimeout(this.pressedToTippedTimer);

				this.pressedToTippedTimer = 0;

			}

		},

		_computeMove: function (index1, index2) {
			var ei1 = this.listOfPositions[index1],
				ei2 = this.listOfPositions[index2],
				dx = ei2.pageX - ei1.pageX,
				dy = ei2.pageY - ei1.pageY,
				d = Math.sqrt(dx * dx + dy * dy),
				duration_ms = ei2.timeStamp - ei1.timeStamp,
				spx = dx / duration_ms,
				spy = dy / duration_ms,
				spd = d / duration_ms;
			return { dx: dx, dy: dy, d: d, spx: spx, spy: spy, spd: spd, duration_ms: duration_ms };
		},

		computeAbsMove: function () {

			return this._computeMove(0, this.listOfPositions.length - 1);

		},

		computeRelMove: function () {

			return this._computeMove(

				this.listOfPositions.length - 2,

				this.listOfPositions.length - 1

			);

		},

		createSignals: function () {
			// Miller Medeiros' Signals lib
			var Signal = signals.Signal;

			this.pressed = new Signal();
			this.tapped = new Signal();
			this.tipped = new Signal();
			this.untipped = new Signal();
			this.swiped = new Signal();
			this.dragStarted = new Signal();
			this.dragged = new Signal();
			this.dragStopped = new Signal();
			this.released = new Signal();
		},

		fsmDraggedTransition: function () {
			var debug = true && Pointer.debug && TipTap.settings.debug;
			var state;

			// if not really dragged, move away without doing anything
			if (this.wasAnUncontrolledMove()) {

				return TipTap.Fsm._SELF;

			}

			md(this + "-fsm(pressing-dragged-1)", debug);

			// because we moved for good, we cancel the planned change of state. Useless in the case of transiting from TIP
			this.cancelPressedToTippedTimer();

			// detects if the move is a swipe
			state = this.isSwipingOrDragging();

			md(this + "-fsm(pressing-dragged-2)", debug);

			// if we detect a swipe, we must go to the corresponding state
			if (state === "swiping") {

				return state;

			}

			md(this + "-fsm(pressing-dragged-3)", debug);

			// tell the world we started a drag :-)
			this.dragStarted.dispatch();

			// and that we dragged
			this.dragged.dispatch();

			return "dragging";
		},

		getDirection: function () {

			return this.direction;

		},

		getInitialPosition: function () {

			return this.listOfPositions[0];

		},

		getPosition: function () {

			return this.listOfPositions[this.listOfPositions.length - 1];

		},

		getState: function () {

			return this.state;

		},

		getTarget$: null,

		getTarget: function () {

			return this.target;

		},

		get$Target: function () {

			return this.$target;

		},

		isSwipingOrDragging: function () {
			var debug = true && Pointer.debug && TipTap.settings.debug;

			var settings = TipTap.settings;
			var dx, dy, adx, ady;

			dx = this.dragDetailsRelative.dx;
			adx = Math.abs(dx);
			dy = this.dragDetailsRelative.dy;
			ady = Math.abs(dy);

			//md(this + ".isSwipingOrDragging-1: " + this.dragDetailsAbsolute.duration_ms + "px", debug)

			md(this + ".isSwipingOrDragging-2", debug);

			if (adx >= ady) {

				md(this + ".isSwipingOrDragging, adx: " + adx, debug, "#0F0")

				if (adx >= settings.swipeMinDisplacement_px) {

					if (dx > 0) {

						md(this + ".isSwipingOrDragging > swipe-r", debug);

						this.direction = Pointer._DIR_RIGHT;

					} else {

						md(this + ".isSwipingOrDragging > swipe-l", debug);

						this.direction = Pointer._DIR_LEFT;

					}

					this.swipeStartPositionIndex = this.listOfPositions.length - 1;

					return "swiping";

				}
			} else {

				if (ady >= settings.swipeMinDisplacement_px) {

					if (dy > 0) {

						md(this + ".isSwipingOrDragging > swipe-b", debug);

						this.direction = Pointer._DIR_BOTTOM;

					} else {

						md(this + ".isSwipingOrDragging > swipe-t", debug);

						this.direction = Pointer._DIR_TOP;

					}

					this.swipeStartPositionIndex = this.listOfPositions.length - 1;

					return "swiping";

				}

			}

			return "tipping";

		},

		notSwipingAnymore: function () {
			var debug = true && Pointer.debug && TipTap.settings.debug;
			var settings = TipTap.settings;

			md(this + ".notSwipingAnymore: " + this.dragDetailsAbsolute.duration_ms + "ms, " + this.dragDetailsAbsolute.d + "px", debug);

			return (
				this._computeMove(
					this.swipeStartPositionIndex,
					this.listOfPositions.length - 1).duration_ms >
					settings.swipeDuration_ms
				) || (this.dragDetailsAbsolute.d > settings.swipeMaxDistance_px);
		},

		onDrag: function (tipTapEvent) {
			var debug = true && Pointer.debug && TipTap.settings.debug;

			this.storePosition(tipTapEvent);

			// computes all the important movement values: distance, speed, duration_ms...
			this.dragDetailsAbsolute = this.computeAbsMove();
			this.dragDetailsRelative = this.computeRelMove();

			Pointer.fsm.dragged.call(this);
		},

		onEnd: function (tipTapEvent) {

			this.storePosition(tipTapEvent);

			Pointer.fsm.ended.call(this);

		},

		onStart: function () {
			Pointer.fsm.pressed.call(this);
		},

		pressedToTipped: function () {

			Pointer.fsm.pressedToTipped.call(this);

		},

		_setTarget$: null,

		_setTarget: function (target) {

			this.target = target;

		},

		_set$Target: function ($target) {

			// add jQuery object wrapper for the DOM
			this.$target = $target;

		},

		startPressedToTippedTimer: function () {
			var debug = true && Pointer.debug && TipTap.settings.debug;

			md(this + ".startPressedToTippedTimer-1", debug);

			if (!this.pressedToTippedTimer) {

				md(this + ".startPressedToTippedTimer-2", debug);

				// start the timer
				this.pressedToTippedTimer = setTimeout(_.bind(this.pressedToTipped, this),
				                                       TipTap.settings.tapMaxDuration_ms);

			}
		},

		storePosition: function (tipTapEvent) {

			this.addPosition(new TipTap.Position(tipTapEvent));

		},

		toString: function () {
			return "---Ptr#" + this.identifier;
		},

		wasAnUncontrolledMove: function () {
			var debug = false && TipTap.settings.debug && Pointer.debug;

			var settings = TipTap.settings;

			md(this + ".wasAnUncontrolledMove(" +
				   Math.abs(this.dragDetailsAbsolute.dx) + "px, " +
				   Math.abs(this.dragDetailsAbsolute.dy) + "px)", debug);

			return ((Math.abs(this.dragDetailsAbsolute.dx) <= settings.moveThreshold_px) &&
				(Math.abs(this.dragDetailsAbsolute.dy) <= settings.moveThreshold_px));
		}

	};

	Pointer.debug = true;

	Pointer.use$ = function (use$) {

		if (use$) {

			this.prototype.getTarget$ = this.prototype.get$Target;
			this.prototype._setTarget$ = this.prototype._set$Target;

		} else {

			this.prototype.getTarget$ = this.prototype.getTarget;
			this.prototype._setTarget$ = this.prototype._setTarget;

		}


	};


	// namespacing
	TipTap.Pointer = Pointer;

}(window.TipTap, _));
